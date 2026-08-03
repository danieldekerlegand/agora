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

Beside that knowledge-plane matrix runs the **media-timeline path**, which is not a codec
of ours at all: KMI §4 adopts OpenTimelineIO, so a timeline is an OTIO document and every
conversion is run by OTIO's own adapters. See "The media-timeline path" below.

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

## The media-timeline path — OpenTimelineIO, adopted

KMI 0.3.0 §4 (koine `ADR-0005`) makes an **OpenTimelineIO `Timeline`, in OTIO's own JSON
serialization**, the canonical composition model. OTIO *is* a canonical-timeline-plus-
adapters, and its CMX3600 / FCP adapters are the ones a bespoke EDL translator would have
reimplemented — so agora uses them. There is **no agora timeline model**: no struct for a
track or a cut, no EDL reader, no EDL writer, and no canonical serialization of our own to
keep in step with OTIO's. What koine adds — identity, lineage, knowledge — rides OTIO's own
`metadata` extension point, so a stock OTIO reader opens a koine timeline unchanged.

**How the engine reaches OTIO.** OTIO is a C++ core with a Python binding; the
`opentimelineio` name on crates.io is an explicitly-marked placeholder (`0.1.0`, *"Rust
bindings for OpenTimelineIO (placeholder)"*) with no bindings in it, so there is no Rust
library for `translation-core` to link. The engine therefore reaches OTIO through its
**Python facade**, and the dependency surface is exactly two OTIO calls:

```
translation-core   crates/core/src/media/     otio.rs carries the OTIO document, checks
                                              KMI §4.1, names §4.3's adapters — converts
                                              nothing. koine.rs is the additive layer.
translation-py     crates/py/src/otio.rs      drives opentimelineio.adapters:
                                              read_from_string / write_to_string
                   crates/py/src/koine.rs     the additive layer at the facade — no OTIO
```

| Facade | Timeline path? | Why |
|---|---|---|
| `translation-py` | **yes** — OTIO in-process | a Python interpreter is where OTIO already runs |
| `translation-core` | carrier + conformance only | nothing to link (see above) |
| `translation-wasm` | no | no OTIO in a wasm sandbox; a TS consumer reaches it over the fabric |
| `translation-service` | no | it is pure native Rust — it would have no OTIO to call |

```python
import translation_py

canonical = translation_py.timeline_from_adapter(edl_text, "cmx_3600")   # OTIO reads
edl_text  = translation_py.timeline_to_adapter(canonical, "cmx_3600")    # OTIO writes
translation_py.otio_adapters()   # what this interpreter can actually reach
```

`opentimelineio` is an **optional runtime dependency** of the extension (`pip install
'translation-py[otio]'`), not a link-time one: every other path through the facade is pure
Rust, and a caller who never touches a timeline never installs it. Since OTIO 0.15 the NLE
adapters of §4.3 are separate plugin distributions (`otio-cmx3600-adapter`,
`otio-fcp-adapter`, `otio-aaf-adapter`), so which formats are reachable is a property of
the interpreter — ask `otio_adapters()`, don't assume.

The fixture the round-trip tests run over (`crates/core/fixtures/timeline.otio.json`) is a
document **OTIO itself wrote**, regenerated by `tools/gen_timeline_fixture.py`; a
hand-authored one would be our opinion about OTIO's schema rather than OTIO's output.
Round-trip fidelity is asserted on both legs: canonical → canonical through OTIO's
serializer is lossless, and canonical → CMX3600 / FCP7 `xmeml` → canonical preserves the
clips, tracks and timing those formats model — lossily at each **format's** own edges
(§4.3), which is why adapter output must travel with the asset-id ↔ path media map.

### What agora keeps: koine's additive layer over OTIO (§4.2)

Adopting OTIO settled the composition and nothing else. The three things OTIO has no model
for are koine's, and they are unchanged by the adoption — `crates/core/src/media/koine.rs`:

| §4.2 | agora | Where it lives |
|---|---|---|
| **(a) identity** | `AssetId` — a KINP asset id is the **hash of the bytes**, so an id that is a *name* is refused | inside the timeline, at `media_reference.metadata.koine.asset` |
| **(b) lineage** | `LineageGraph` over §3's four relations, none of them identity-bearing | **outside** — KGP assertions over assets |
| **(c) knowledge** | `analysis_assertions` — media analysis → world-scoped KGP claims | **outside** — KGP assertions in the asset's world |

Only (a) travels inside the document, and that is exactly what a path-addressing NLE format
drops (KMI §9.5): an EDL carries paths, not namespaced metadata. So the §4.3 media map is
load-bearing, and `Timeline::relink` is the repair — asserted against OTIO's real `cmx_3600`
adapter in `crates/py/tests/test_otio_koine_layer.py`. It restores identity and never mints
it: an id already present outranks the map, and a location the map does not name stays
unidentified and is *reported* rather than guessed.

(b) and (c) survive any adapter for a stronger reason — they were never in the document.
That is also why the analysis bridge is additive over OTIO rather than replaced by it: an
OTIO `Marker` has no confidence, no provenance and no world, so knowledge stays a KGP
assertion, scoped to the analyzed asset's `source_world` — or, for a composite, to each
**constituent's** world traced through lineage (delta H), because scoping a generated render
to one world would drop its clips' claims out of every fictional world. A claim the bridge
cannot scope is an error, never a claim in consensus reality. The assertions project onto
the engine's own fact vocabulary (`rel/3` + `rel_conf` / `rel_world` / `rel_source`
companions), so a claim is a record the ProbLog emitter can render — not generated text.

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
