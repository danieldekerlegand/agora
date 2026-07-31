# agora translation engine

The one place in the commons where Rust earns its keep: CPU-bound serde over the koine
canonical node/edge graph. A single native core (`crates/core`) is a faithful,
byte-compatible port of the culture-scrape exporters it was extracted from, covering the full matrix
canonical-graph ↔ {TSV, CSV, Neo4j/Cypher, Prolog, Soufflé-Datalog, ProbLog}. It is a
verified reimplementation, not an approximation — the golden tests assert byte-for-byte
equality against culture-scrape's own output on a shared fixture.

## Layout

```
crates/core      translation-core   — the one implementation (embeddable, no fs/network)
crates/wasm      translation-wasm    — wasm-bindgen facade for TypeScript consumers (US-4)
crates/py        translation-py      — PyO3 facade for Python consumers (US-5)
crates/service   translation-service — a thin HTTP transform leaf (US-6)
crates/wire      translation-wire    — OpenAI <-> native-vendor wire, + an Erlang port program
```

There is **one core and several facades**. WASM, PyO3, and the HTTP service each add only
a boundary crossing; none reimplements a codec, so all of them emit bytes identical to
`translation-core`.

## Embed first — the HTTP service is the boundary of last resort

agora is the connective-tissue translation home; it must **not** become an ESB. So the
rule is: **embed the crate; dial the service only across a boundary an embed cannot
cross.**

- **TypeScript** (the console, any TS participant): embed `translation-wasm`. It translates
  **in-process, zero network hop**.
- **Python** (any Python participant): embed `translation-py`. Same — in-process, zero hop.
- **Only** when the caller is in a language or process that cannot link the crate do you
  reach for `translation-service`: a directly-dialed KCB leaf that adds transport (and
  nothing else) over the same core.

Per ADR-0001 (decisions 1–2), the service is a **leaf**, not a hub. It is discovered via
the KCB manifest it publishes, dialed on demand, and returns the translation to the
caller. It **never** relays or transforms another service's inter-platform traffic: it
holds no peer routing table and advertises only its own `transform` capability.
`describe_transform().proxies_traffic` is always `false`, asserted in the tests — a
statement about what this service *is*, not a toggle.

## The vendor-wire codec (`crates/wire`)

The one facade that is not over the canonical graph. agora's provider-router speaks OpenAI's
dialect down every rung of its ladder; seven paid vendors (anthropic, gemini, replicate,
elevenlabs, runway, luma, minimax) publish their own request and response shapes, so before
this crate the router recognised them and fell through. `translation_wire::to_native` /
`from_native` are that adapter — pure serde, no clock, no network, called once out and once
back per generation.

The Erlang router (agora:80) embeds it the only way the BEAM can: `agora-translation-port`, a
`{packet, 4}` port program over the same functions. Not a NIF, deliberately — the router's
invariant is that no rung can take down the node, and an OS process is a structural guarantee
of that where a NIF would be a promise about the Rust. See `provider-router-erl/README.md`.

Every rendered document goes out as an ordered JSON *string* serialized from a typed struct, so
the OpenAI envelope keeps the key order a client sees from OpenAI itself; `serde_json::Value`
sorts its keys and would quietly reorder a relayed response.

## The transform service

`translation-service` publishes a KCB capability manifest at
`/.well-known/kcb-manifest.json` (capability-bus.md §2) naming a single `transform`
capability whose ports are plane-typed (KCB §2.1 / KMI §6): a knowledge-plane canonical
graph in, the target dialect out. `POST /transform` with `{"format": "...", "graph":
{...}}` returns the translation; `GET /` returns the ADR-0001 self-description.

```
AGORA_TRANSLATION_HOST   bind host   (default 127.0.0.1)
AGORA_TRANSLATION_PORT   bind port   (default 8790)
```

## Quality gate

`make check-translation` (wired into `make check`) runs `cargo build`, `cargo clippy
--all-targets -- -D warnings`, and `cargo test` over the native default members
(core + wasm rlib + service), then the WASM and PyO3 binding steps (`crates/wasm/test.sh`,
`crates/py/test.sh`).
