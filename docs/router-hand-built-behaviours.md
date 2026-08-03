# Which provider-router behaviours must remain hand-built

**Status:** the US-3 record for the LiteLLM leaf-gateway tasklist. **Decision: NO-GO on
retiring or repointing the dual Erlang/Python router.** Nothing was retired, nothing was
repointed, and the conformance corpus stays **live** — it keeps asserting code paths that
still run, and this story added the guard that keeps that true.

**Reads with:** [the US-1 spike](spike-litellm-leaf.md) (the evidence), [the LiteLLM dispatch
adapter](litellm-dispatch-adapter.md) (what US-2 actually borrowed), and
`../koine/decisions/ADR-0004` (why the Erlang router is canonical).

US-3's own gate is conditional:

> GATED ON US-1 and US-2: proceed only if the spike confirmed LiteLLM covers the behaviours
> the byte-identical Erlang/Python dual router encodes; **otherwise this story documents
> precisely which router behaviours must remain hand-built and stops there.**

The spike did not confirm it, so this document is the story. It is deliberately a *list of
what stays*, at the granularity of a module and its assertions, rather than a restatement of
the spike's argument — the argument is §4 there; the inventory is here, so that a future
iteration considering the same swap can check its ambitions against a concrete surface
instead of a summary.

---

## 1. Why NO-GO, in one paragraph each

**The canonical router is Erlang; LiteLLM is a Python library.** ADR-0004 made
`provider-router-erl/` the router of record and `provider-router/` the executable
specification it is judged against. `apr_conformance_SUITE` demands the two answer with
*identical bytes* — key order, float spelling and separators included (`apr_json` keeps
objects ordered precisely so a body is reproducible). A Python-only dependency cannot be
adopted on the canonical side at all, and adopting it on the specification side alone breaks
the equality the suite exists to assert. This is why US-2's adapter is off by default behind
`AGORA_LITELLM=1`: the *default* Python surface has to remain byte-for-byte what it was.

**The corpus pins exactly the two things LiteLLM does not do.** `python-surface.json` records
two environments: **bare**, where every one of the five modalities falls to the placeholder,
and **keyed**, where a ceiling of zero refuses the paid rung *without dialing it*. Those are
needs N1 and N4 from the spike — both NOT COVERED. Any LiteLLM-backed path would have to
reproduce them from agora code, so the corpus would be asserting agora's logic either way.
Retiring the internals would not shrink the contract; it would only move it.

**The Erlang router is more than a model gateway.** Beyond the shared OpenAI surface it
carries the KCB bus half — `apr_bus` (subscribe/fan-out), `apr_events` (a published event per
generation), `apr_assets` (the content-addressed `fetch` store), `apr_grant` (capability
tokens with their own `budget_units` ceiling) and `apr_translate` (the port program to the
Rust translation engine). LiteLLM is not in that category and does not claim to be.

---

## 2. The keep-list

Every row is a behaviour the swap would have had to preserve, the reason it cannot be
delegated, and where it lives and is asserted on both sides. "Need" cites the spike's verdict
table.

### 2.1 The differentiators the tasklist named as must-survive

| Behaviour | Need | Python | Erlang | Asserted by |
|---|---|---|---|---|
| The **terminal placeholder rung** — deterministic, offline, free, appended to every modality and not a configurable ladder token | N1 **NOT COVERED** | `placeholder.py`, `ladder.py` (`PLACEHOLDER`) | `apr_placeholder`, `apr_placeholder_worker` | `tests/test_zero_spend.py`, `apr_zero_spend_SUITE`, the corpus' bare environment |
| **`complete` never raises on runtime state** — a keyless install answers every request | N1 **NOT COVERED** (LiteLLM's chain terminates only because agora's last entry cannot fail) | `router.py` | `apr_router`, `apr_ladder_sup` | `tests/test_zero_spend.py`, `tests/test_fallthrough.py`, `apr_zero_spend_SUITE` |
| The **per-request ceiling** (`budget_units` in the body, `X-Agora-Budget-Units` in a header) supplied by the caller, not the deployment | N4 **NOT COVERED** (LiteLLM's four budget primitives are cumulative and abort) | `cost.py`, `app.py` | `apr_cost`, `apr_generate_handler` | `tests/test_budget.py`, `apr_budget_SUITE`, the corpus' keyed + ceiling exchanges |
| **Skip without dialing** — an over-ceiling rung is refused before it is contacted, and `Attempt.dialed` makes that auditable | N4 **NOT COVERED** (LiteLLM's cost strategy *ranks* deployments; it never refuses one) | `router.py`, `cost.py` | `apr_router`, `apr_rung_worker` | `tests/test_budget.py`, `apr_budget_SUITE`, `tests/test_conformance_fixture.py` |
| **KCB exposure** — the AgentCard, the KCB manifest extension, the resolved-tier `cost` block the registry prefers zero-cost routes by | N6 **NOT COVERED** (LiteLLM's A2A support is a client; it publishes nothing about itself) | `manifest.py` | `apr_manifest`, `apr_manifest_handler`, `apr_redirect_handler` | `tests/test_manifest.py`, `schemas/`, the corpus' two well-known reads |

### 2.2 The cost model

| Behaviour | Need | Why it cannot be delegated |
|---|---|---|
| **`unpriced` never passes a ceiling** | N5 **NOT COVERED** | `litellm.cost_per_token` returns `(0, 0)` for an unmapped model — *free* where it means *unknown*. Inheriting that makes an unknown vendor the cheapest route in the ladder. |
| **Denomination in KCB `budget_units`**, anchored at 1 unit = US$0.00001 | N5 **NOT COVERED** | A ceiling travels between projects with no shared billing account, so it cannot be USD. A conversion is trivial; a *silent* one is a mispriced ceiling. |
| **Non-text `measure()`** — seconds of video, characters of speech, `n` images, each erring high on purpose | N5 **NOT COVERED** | LiteLLM prices tokens. |
| **`AGORA_PRICE_TABLE` / `AGORA_PRICE_<MODALITY>_<PROVIDER>` overrides** over the shipped `prices.toml` | — | The sheet is data with a documented anchor; LiteLLM's map is a candidate *source* of rates to layer underneath, never a replacement for the rules above. |

Sites: `cost.py` + `prices.toml` / `apr_cost`; asserted by `tests/test_cost.py`,
`apr_cost_tests`.

### 2.3 The routing surface

| Behaviour | Python | Erlang | Asserted by |
|---|---|---|---|
| The four-tier ladder `paid → mlx → local → placeholder`, per modality, ordered by `AGORA_<MODALITY>_LADDER` with `AGORA_PREFER_LOCAL=1` fronting the zero-spend tiers | `ladder.py` | `apr_ladder` | `tests/test_ladder.py`, `apr_ladder_tests` |
| `resolve_all` never raises, so `/doctor` always answers | `ladder.py`, `app.py` | `apr_ladder`, `apr_doctor_handler` | `tests/test_app.py`, `apr_http_SUITE` |
| An unadaptable vendor resolves to **`pending-adapter`** — a named, reported refusal rather than a fake tier that fails on every real request | `backends.py` | `apr_backends` | `tests/test_ladder.py`, `tests/test_litellm_dispatch.py` |
| No read endpoint echoes a configured key, and a failed rung redacts it from its reason | `app.py`, `router.py` | `apr_doctor_handler`, `apr_router` | `apr_conformance_SUITE` (two dedicated cases) |
| `/v1/audio/music-generations` — agora's own route over its own vendors | `app.py` | `apr_routes`, `apr_generate_handler` | both routers' route tables, the corpus' music generation |

### 2.4 The bus half — Erlang only, no Python or LiteLLM counterpart

`/v1/subscribe` and `/v1/assets/:id`, over `apr_bus`, `apr_events`, `apr_assets`, `apr_grant`
and `apr_translate`; asserted by `apr_subscribe_SUITE`, `apr_grant_tests`,
`apr_translate_SUITE` and `apr_translate_tests`. Out of scope for any model-gateway swap by
definition — it implements `capability-bus.md` §4–§5, not a completion API.

### 2.5 What *is* delegated, for contrast

One thing, below the transport boundary: dispatch for the `wire="native"` paid vendors
LiteLLM covers *in the modality agora routes them for* — Anthropic and Gemini, off by default
behind `AGORA_LITELLM=1`. See [the adapter record](litellm-dispatch-adapter.md). Every row
above sits above that boundary, which is why turning the adapter on cannot reach any of them.

---

## 3. The corpus is live, not frozen

US-3's gate allows the conformance corpus to be *either* frozen as a historical record *or*
updated to assert a new implementation's contract, and forbids the third state: left asserting
a code path that no longer runs. Since nothing was retired, the corpus is in neither of the
first two states — it is simply **current**, and the honest way to say so is to check it
rather than assert it.

`provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json` is a capture of the
Python router taken by `capture_python_surface.py` beside it. Both halves of that equality are
now checked:

* **Erlang side** — `apr_conformance_SUITE` replays the corpus and demands identical bytes.
  It runs under `make check-router-erl`, which **skips** on a host without rebar3.
* **Python side** — `provider-router/tests/test_python_surface_corpus.py` (added by this
  story) re-runs the capture in a subprocess and compares the exact bytes to the committed
  file. It runs under `make check-provider-router`, i.e. everywhere.

That second check is the gap this story closes. Before it, a change to the Python router on a
rebar3-less host could silently invalidate the corpus, and the first symptom would have been
the canonical Erlang router being held to a surface no code produced any more. The failure
message carries the regenerate command; a difference is either an intended contract change
(regenerate, and change the Erlang router to match) or an accidental one (revert it).

Two related pins, unchanged by this story and worth naming in the same breath, because
together the three are what "the corpus asserts a live path" means:
`provider-router/tests/test_conformance_fixture.py` (the console's captured session is still
what this router answers) and `apr_conformance_SUITE`'s
`the_console_captured_session_is_still_a_capture_of_this_router` (…and what the Erlang one
answers).

---

## 4. The external wire contract, unchanged

No caller-visible behaviour changed on this tasklist. The full surface, and what holds each
part of it:

| Surface | Held by |
|---|---|
| `GET /health`, `GET /doctor`, `GET /v1/models`, `GET /v1/providers` | the corpus' `READS`, in both environments |
| `GET /.well-known/agent-card.json`, and the 308 from the pre-0.3.0 `/.well-known/kcb-manifest.json` onto it | the corpus' reads (which capture `location`) + `tests/test_manifest.py` |
| `POST /v1/chat/completions`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/music-generations`, `/v1/video/generations` | the corpus' `GENERATIONS` (one per modality) |
| The ceiling in both spellings, and the refusal of an unreadable or negative one | the corpus' `CEILINGS` (four exchanges) |
| The reported routing headers `x-agora-tier`, `x-agora-provider`, `x-agora-model`, `x-agora-cost-units`, `location` | captured with every exchange in the corpus |
| `AGORA_*` configuration — `AGORA_ENV_FILE`, `AGORA_HOST`/`AGORA_PORT`, `AGORA_PUBLIC_BASE_URL`, `AGORA_ROUTER_IDENTITY`, `AGORA_PREFER_LOCAL`, `AGORA_<MODALITY>_LADDER`, `AGORA_PROVIDER_<NAME>_<FIELD>`, `AGORA_PRICE_TABLE`, `AGORA_PRICE_<MODALITY>_<PROVIDER>` | `tests/test_config.py`, `apr_config_tests`; the corpus fixes two of them per environment |
| `AGORA_LITELLM` — the one variable this tasklist added, **unset by default**, which is what keeps the corpus reproducible | `tests/test_litellm_dispatch.py`; `apr_conformance_SUITE` scrubs the `AGORA_*` prefix before every case |

The `kcs:provider-router-roundtrip` scenario — discover through the registry, dial the
returned address, ask with a ceiling of zero, assert the placeholder served it for nothing —
still passes end to end: `console/src/kcs/runner.test.ts` and `console/src/App.test.tsx`
replay it against `console/src/fixtures/provider-router.session.json`, and that fixture is
pinned to the live router by `test_conformance_fixture.py` (Python) and
`apr_conformance_SUITE` (Erlang). The console replays rather than opens a socket by design —
the capture is what makes the scenario reproducible in a gate.

---

## 5. What would have to change for this decision to be revisited

Not a plan, a set of preconditions — so that a future iteration can tell a real change of
facts from a change of mood:

1. **The bottom rung.** An upstream mechanism for a *terminal* rung that cannot fail, not a
   fallback chain that happens to end in one.
2. **The ceiling.** A per-request, caller-supplied ceiling that causes a fall-through to a
   cheaper rung rather than an abort, and that refuses a rung **before** contacting it.
3. **Unknown ≠ free.** An unmapped model must be refusable rather than priced at zero.
4. **The canonical side.** Something reachable from Erlang — a sidecar over the wire, not a
   library import — or a reversal of ADR-0004.

Until all four hold, the equality `apr_conformance_SUITE` asserts is the cheaper guarantee,
and the swap would trade a verified contract for a dependency.

---

## 6. Verification record

What was actually run for this story, on 2026-08-02:

* `capture_python_surface.py` regenerated and diffed against the committed corpus — **no
  difference**, which is what licenses §3's claim that it is live.
* The new `test_python_surface_corpus.py` was checked in both directions: green on the
  committed corpus, and red (with the byte-level diff) against a one-character mutation of it.
* `make check` — every area's gate, exit 0. `check-router-erl` reports its skip on this host
  (no rebar3), which is exactly the hole §3's new test fills.
