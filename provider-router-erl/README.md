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
  apr_routes.erl                the route table — one source for paths/0 and the cowboy dispatch
  apr_health.erl                the byte-identical /health body
  apr_health_handler.erl        cowboy handler: GET /health
  apr_stub_handler.erl          defined 501 for the not-yet-implemented routes (US-2..US-5)
  agora_provider_router_app.erl OTP application — boots the cowboy listener
  agora_provider_router_sup.erl top supervisor (grows into the ladder tree in US-2)
test/
  apr_routes_tests.erl          eunit: route table == app.py surface; /health byte-identical
  apr_http_SUITE.erl            common_test: boots the app over HTTP and drives the surface
```

## Gate

`make check-router-erl` from the repo root runs `rebar3 compile`, `rebar3 dialyzer`,
`rebar3 eunit`, and `rebar3 ct`. It is wired into `make check`. Following agora's
native-optional convention (`check-path-index`, `check-translation`), the gate **skips
cleanly** on a host without the Erlang toolchain (`rebar3` not on `PATH`) so a Rust/TS-only
checkout still passes `make check`; install Erlang/OTP (≥26) + rebar3 to run it for real.
