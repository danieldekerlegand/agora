# provider-router-erl

The **Erlang/OTP re-implementation** of the agora provider-router (agora:80, ratified in
`../../koine/decisions/ADR-0004`). It supersedes the Python router in `../provider-router/`
(agora:50) while preserving its external contract byte-for-byte — the OpenAI-compatible HTTP
surface, the KCB capability manifest, the `budget_units` spend ceilings (KCB §5), and the
always-completes / ZERO-SPEND invariant.

Language is internal (ADR-0001): this is a service over the wire, never shared as
cross-language source. The Python router remains the contract of record until the
supersession cutover completes across US-1..US-6.

## Layout (grows per story)

```
src/
  apr.erl                       constants — version, kcb_version, identity (mirrors __init__.py)
  apr_json.erl                  JSON codec — ORDERED objects for responses, sorted for digests
  apr_config.erl                AGORA_PROVIDER_* settings; secrets never reach describe/1
  apr_ladder.erl                the sacred ladder — tier order, AGORA_<MODALITY>_LADDER
  apr_backends.erl              tier -> a dialable backend, or why not
  apr_cost.erl                  the agora:50 price table + the budget_units ceiling (KCB §5)
  apr_placeholder.erl           the deterministic terminal tier
  apr_manifest.erl              the KCB capability manifest / A2A AgentCard (KCB §2, §6)
  apr_router.erl                resolution, the ladder walk, and the routing report
  apr_ladder_sup.erl            one modality subtree per modality
  apr_modality_sup.erl          a modality's rung workers + its permanent placeholder worker
  apr_rung_worker.erl           one gen_server per (modality, tier) — prices, then dials
  apr_placeholder_worker.erl    the terminal worker: offline, free, never refusable
  apr_grant.erl                 capability grants — verb + scope + spend ceiling (KCB §5)
  apr_bus.erl                   the subscribe registry and the fan-out (KCB §4)
  apr_subscriber.erl            one process per consumer — seen set, ledger, delivery
  apr_subscriber_sup.erl        the dynamic (temporary) tree of live subscriptions
  apr_events.erl                what a completed generation announces on the bus
  apr_assets.erl                the content-addressed store behind the fetch verb
  apr_health.erl                the byte-identical /health body
  apr_*_handler.erl             cowboy handlers: health, doctor, manifest, redirect, generate,
                                subscribe (SSE), fetch
  apr_stub_handler.erl          defined 501 for /v1/models and /v1/providers (US-6)
  agora_provider_router_app.erl OTP application — boots the cowboy listener
  agora_provider_router_sup.erl top supervisor, over the ladder tree and the bus
test/
  apr_routes_tests.erl          eunit: route table == app.py surface; /health byte-identical
  apr_ladder_tests.erl          eunit: the ladder, ported from test_ladder.py
  apr_cost_tests.erl            eunit: the price table + the two safety rules (test_cost.py)
  apr_grant_tests.erl           eunit: grants, topics, event identity, asset ids (KCB §4/§5)
  apr_http_SUITE.erl            common_test: boots the app over HTTP and drives the surface
  apr_zero_spend_SUITE.erl      common_test: ZERO-SPEND / always-completes (test_zero_spend.py)
  apr_budget_SUITE.erl          common_test: the ceiling, the routing report, the manifest
  apr_subscribe_SUITE.erl       common_test: the subscribe fan-out, grants, fetch, isolation
```

## The capability bus (KCB §4)

`subscribe` and `fetch` are verbs the spec defines for every KCB provider; the Python router
surfaced neither, so they arrive here as **additions beside** the mirrored contract, never as
edits to it (`apr_routes:contract_paths/0` vs `bus_paths/0` — the first set is what US-6's
conformance fixture pins byte-for-byte, and the AgentCard is left exactly as it was).

- `POST /v1/subscribe` opens a `text/event-stream` for a `world/<world>` or
  `capability/<name>` topic. Registration needs a grant covering `subscribe` on the topic's
  scope (§5), and the grant's `budget_units` ceiling is checked twice — once against what one
  event on a capability topic is projected to cost, so a grant that could never afford a
  delivery is refused outright, and then event by event on the stream.
- `GET /v1/assets/<digest>` is the `fetch` verb, gated by a `fetch:asset` grant. An asset that
  has not propagated yet is a `404` carrying `"pending": true` — "not yet" and "never" are
  different answers, and delta L says a reference is *allowed* to outrun its bytes.

Each subscription is its own process under a `temporary` `simple_one_for_one` tree, so a
consumer that cannot keep up costs only itself: publishing is a cast per subscriber and never
blocks the ladder. Events carry content-addressed ids, which is what lets the fan-out be
at-least-once — a redelivery is dropped by the subscriber, and nothing anywhere inspects
arrival order.

## The manifest paths

`app.py` serves the A2A AgentCard — the KCB manifest folded onto it as a named extension
(capability-bus.md §2/§6) — at `/.well-known/agent-card.json`, and answers the pre-0.3.0
`/.well-known/kcb-manifest.json` with a **308** onto it. Both are registered here, with the
same statuses and the same bodies: a 0.2.0 crawler must land on the authoritative document
rather than a dead address, and byte-for-byte conformance (US-6) is judged against the card.

## Gate

`make check-router-erl` from the repo root runs `rebar3 compile`, `rebar3 dialyzer`,
`rebar3 eunit`, and `rebar3 ct`. It is wired into `make check`. Following agora's
native-optional convention (`check-path-index`, `check-translation`), the gate **skips
cleanly** on a host without the Erlang toolchain (`rebar3` not on `PATH`) so a Rust/TS-only
checkout still passes `make check`; install Erlang/OTP (≥26) + rebar3 to run it for real.
