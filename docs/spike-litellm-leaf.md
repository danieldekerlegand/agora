# Spike — does LiteLLM cover the leaf gateway's needs?

**Status:** complete. **Subject:** `litellm==1.95.0` (MIT), evaluated 2026-08-02.
**Evidence:** `docs/spikes/litellm-leaf/spike_litellm.py`, run with
`./docs/spikes/litellm-leaf/run.sh`. Full transcript in the appendix; every verdict below
cites an experiment number from it. Nothing here was migrated — no production code changed
and `make check-provider-router` / `make check-router-erl` stay green.

The question this spike answers is narrow and it is not "is LiteLLM good". It is: **which of
the provider-router's behaviours are commodity** — already solved by an off-the-shelf
OpenAI-compatible multi-provider gateway — **and which are agora's own**, such that swapping
the internals would quietly delete a guarantee the rest of the commons depends on.

The provider-router is a LEAF capability (ADR-0001): one model-backend ladder, reached over
the wire, exposed as a KCB capability. It is not the discovery registry, so nothing in this
spike touches `registry/`.

---

## 1. The verdict table

| # | Need | Verdict | Mechanism / gap |
|---|---|---|---|
| N1 | Always-completes deterministic **placeholder** bottom rung, zero spend | **COVERED-WITH-A-THIN-SHIM** (mechanism) / **NOT COVERED** (invariant) | A `litellm.CustomLLM` in `litellm.custom_provider_map` + `litellm.utils.custom_llm_setup()` serves it offline (exp 2), and a `Router` fallback chain reaches it when the rung above errors (exp 3). But LiteLLM has no *terminal-rung* concept: the chain terminates only because agora's last entry cannot fail. The guarantee stays agora's either way. |
| N2 | **mlx-serve** tier | **COVERED** | `openai/<model>` + `api_base` — mlx-serve serves the OpenAI wire natively, so it needs no adapter (exp 4). Identical to what `backends.py` already does. |
| N3 | **Local / Ollama** tier | **COVERED** | `ollama_chat/<model>` is a first-class provider with a configurable `api_base` (exp 5). |
| N4 | **Per-request budget ceiling** that skips an over-ceiling tier *without dialing it* | **NOT COVERED** | There is no per-request ceiling parameter anywhere on the call surface (exp 7). LiteLLM's budget primitives are cumulative and they **abort** rather than fall through (exp 7); its cost strategy **ranks** deployments but never refuses one (exp 8). The pre-dial filter is ~10 lines and lives outside LiteLLM (exp 8, which proves the over-ceiling rung is dialed **0 times**). |
| N5 | **Cost estimation** per tier/modality | **COVERED-WITH-A-THIN-SHIM** for text pricing / **NOT COVERED** for the two safety rules | `token_counter` + `cost_per_token` project a text request before dispatch, off a 2985-model built-in price map (exp 6). But an **unmapped** model prices as `(0, 0)` — LiteLLM's estimator says *free* where it means *unknown* (exp 6) — and it prices in **USD**, not KCB `budget_units`. Non-text quantities (seconds of video, characters of speech, `n` images) have no LiteLLM equivalent. |
| N6 | Exposure as a **KCB capability** (AgentCard + manifest extension) | **NOT COVERED** | LiteLLM's A2A support is a *client*: `litellm/a2a_protocol/card_resolver.py` **fetches** other agents' cards. Nothing publishes one for itself, and there is no notion of a KCB manifest extension. `manifest.py` stays exactly as it is. |
| N7 | The five modalities the router ladders | **PARTIAL** | text / image / speech / video have LiteLLM surfaces; **music has none at all** (exp 9). `/v1/audio/music-generations` is agora's own route over its own vendors. |

Two of the three differentiators the tasklist named as must-survive (the zero-spend
always-completes bottom rung, and per-request ceilings that skip without dialing) are **not**
things LiteLLM does. The third (KCB exposure) it does not do either. That is the headline.

---

## 2. What LiteLLM would actually buy agora

The commodity that LiteLLM genuinely owns is **vendor wire adapters plus a maintained price
map** — and that is precisely where the current router is weakest, not where it is strongest.

`backends.py` declares seven vendors with `wire="native"` (Anthropic, Gemini, Replicate,
ElevenLabs, Runway, Luma, MiniMax). All seven resolve to `pending-adapter`: the router
recognises them, reports them, and refuses to dial them rather than send a wire format they
do not speak. LiteLLM covers five of the seven today, in the modality agora wants:

| agora vendor | in LiteLLM | modes LiteLLM prices for it |
|---|---|---|
| anthropic | yes | `chat` (24 models) |
| gemini | yes | `chat`, `image_generation`, `audio_speech`, `video_generation`, … |
| replicate | yes | `chat` (40) — **not** the image/music modes agora routes it for |
| elevenlabs | yes | `audio_speech`, `audio_transcription` |
| minimax | yes | `chat`, `audio_speech` — **not** video |
| runway | **no** | — |
| luma | **no** | — |

So the honest upside is: **Anthropic, Gemini and ElevenLabs become dialable rungs for text
and speech**, and the maintained price map replaces hand-curated rates for the paid tier.
That is real value, and it is the *only* part of the router LiteLLM is better at.

The cost of that value: 86 declared dependencies (12 in the core, non-`proxy` install),
~166 MB installed, and an `openai>=2.20` pin the router does not otherwise carry. The license
is MIT — compatible with agora's Apache-2.0 — with the enterprise pieces confined to the
proxy tree agora would not use.

---

## 3. Need by need

### N1 — the always-completes, zero-spend placeholder (exp 2, exp 3)

A `litellm.CustomLLM` registered under a provider name serves a deterministic, offline,
zero-token response, and `Router` falls back to it when the rung above errors. Two things a
reader would assume, that are not true:

* **Registration takes an undocumented second step.** Setting `litellm.custom_provider_map`
  is enough for the top-level `litellm.completion`, but `Router` construction rejects the
  same model with `BadRequestError: LLM Provider NOT provided` until
  `litellm.utils.custom_llm_setup()` populates `litellm._custom_providers`.
* **The base `CustomLLM` raises `CustomLLMError("Not implemented yet!")`** for whichever of
  `completion` / `acompletion` you leave out, and the Router only ever takes the async half —
  a sync-only handler is a fallback chain that ends in an exception.

Neither is a blocker; both are why "LiteLLM has fallbacks" is not the same claim as "LiteLLM
has an always-completes bottom rung". The router's invariant is that
`Router.complete` does not raise on runtime state — a property of the *last* rung being
offline and free, which agora asserts in `tests/test_zero_spend.py`. LiteLLM cannot express
that property, so nothing it provides can be trusted to preserve it. **Keep it hand-built.**

### N2 / N3 — mlx-serve and local (exp 4, exp 5)

Both are genuinely covered and both are already trivial in agora: mlx-serve is `openai/` plus
a base URL, Ollama is a named provider. The one caveat is pricing, not dispatch — see N5.
Note that `resolve_tier` deliberately refuses to assume a localhost port; LiteLLM defaults
`ollama` to `http://localhost:11434`, which would make "no local server configured" depend on
whatever happens to be listening on the box. That default must be overridden, not inherited.

### N4 — the per-request ceiling (exp 7, exp 8)

This is the load-bearing gap. LiteLLM has four budget-shaped things and none of them is the
one KCB §5 describes:

1. `litellm.max_budget` — process-global, **cumulative** spend, checked against spend so far,
   and it **raises `BudgetExceededError`** (exp 7). A request that cannot afford the paid tier
   gets an exception, not the free tier.
2. Proxy virtual-key `max_budget` — per API key, cumulative over a time window, requires
   running the LiteLLM **proxy server plus a database**. Same abort semantics.
3. `provider_budget_config` / `RouterBudgetLimiting` — per-provider spend over a window.
   Again cumulative, again not the caller's.
4. `routing_strategy="cost-based-routing"` — **ranks** deployments and picks the cheapest
   (exp 8 shows it choosing Groq over GPT-4o-mini). It has no ceiling to refuse against.

agora's semantics are different in kind: the ceiling is **supplied by the caller per request**
(`budget_units` in the body or `X-Agora-Budget-Units`), the ladder order is a *preference* and
the ceiling is a *constraint*, and an over-ceiling rung is skipped **without being contacted**
so that `Attempt.dialed == False` is auditable. Experiment 8 implements exactly that filter in
ten lines over LiteLLM's own primitives and proves the paid rung is dialed zero times — which
is the point: **the filter is agora's, and it works just as well above LiteLLM as above
`httpx`.** `cost.py` and the `within` / `refusal` / `Attempt.dialed` machinery stay.

### N5 — cost estimation (exp 6)

`token_counter` + `cost_per_token` are a usable pre-dial projection for text, backed by a
price map far larger and better maintained than `prices.toml`. Three things do not carry over:

* **`unpriced` has no LiteLLM equivalent, and the default is unsafe.**
  `cost_per_token("ollama/llama3.2")` returns `(0, 0)` for a model absent from the map. In
  agora that is the one thing pricing must never do: `rate_for` returns `(0.0, unpriced=True)`
  and `within` refuses an unpriced rung under any ceiling, because "we don't know" must not
  read as "free" or an unknown vendor becomes the cheapest route in the ladder. (LiteLLM is
  inconsistent here: `completion_cost` on an unmapped model *raises* — loud, but at settle
  time, where it is a 500 rather than a routing signal.)
* **The unit is USD, not `budget_units`.** KCB ceilings travel between projects with no shared
  billing account; agora's sheet is anchored at 1 unit = US$0.00001. A conversion is trivial;
  a *silent* one is a mispriced ceiling.
* **Non-text quantity has no equivalent.** `measure()` sizes seconds of video, characters of
  speech and `n` images, each erring high on purpose. LiteLLM prices tokens.

Verdict: LiteLLM's map is a good **source of rates** to layer under `AGORA_PRICE_TABLE`. It is
not a replacement for `cost.py`.

### N6 — KCB exposure

`litellm/a2a_protocol/` resolves *remote* agent cards (`/.well-known/agent-card.json`) so
LiteLLM can call A2A agents through the completion interface. It publishes nothing about
itself, and knows nothing of the KCB manifest extension URI, the per-modality capability
entries or the resolved-tier `cost` block that lets the registry prefer zero-cost routes.
`manifest.py` is untouched by any swap.

### N7 — modality coverage (exp 9)

`acompletion` / `aimage_generation` / `aspeech` / `avideo_generation` exist; there is no music
generation surface. Whatever LiteLLM fronts, `/v1/audio/music-generations` keeps its own path.

---

## 4. Go / no-go per downstream story

### US-2 — front LiteLLM behind agora's OpenAI surface → **GO, NARROWED**

> **Landed.** See [`litellm-dispatch-adapter.md`](litellm-dispatch-adapter.md) for what was
> delegated, what was kept hand-built, and the one correction this section needs: LiteLLM
> covers five of the seven native-wire vendors, but only **two** of those (Anthropic, Gemini)
> line up with the modality agora actually routes the vendor for, so only two became dialable.

Its gate reads: *proceed only if the spike cleared the placeholder, mlx-serve, local,
budget-ceiling and cost-estimation needs; if any was NOT COVERED, this story instead lands the
documented shim/keep-decision for that need and says so in its commit.*

N4 (budget ceiling) is NOT COVERED and N5 (cost estimation) is NOT COVERED for its two safety
rules, so **US-2 proceeds in its documented-keep-decision form**, which is the same shape of
work either way:

* **Delegate to LiteLLM** the thing it is better at — dispatch for the paid tier, which turns
  Anthropic / Gemini / ElevenLabs from `pending-adapter` into dialable rungs. mlx and local
  may route through it too (N2/N3 are COVERED) but gain nothing by doing so; they are already
  one OpenAI POST.
* **Keep hand-built, and say so in the commit:** the placeholder rung and the always-completes
  invariant (N1), the per-request pre-dial ceiling and `Attempt.dialed` audit (N4), `cost.py`'s
  `unpriced` rule / `budget_units` denomination / non-text `measure()` (N5), the AgentCard and
  KCB manifest (N6), and the music route (N7).
* **The acceptance evidence stays behavioural**: a zero-ceiling request must still land on the
  placeholder having dialed nothing, demonstrated by a test rather than asserted.

### US-3 — retire or repoint the dual Erlang/Python router and its corpus → **NO-GO**

> **Landed as documentation.** The full keep-list — behaviour by behaviour, with its site and
> its assertions in both routers — is
> [`router-hand-built-behaviours.md`](router-hand-built-behaviours.md), which also records why
> the corpus is *live* rather than frozen and adds the Python-side check that keeps it so.

Its gate reads: *proceed only if the spike confirmed LiteLLM covers the behaviours the
byte-identical Erlang/Python dual router encodes; otherwise this story documents precisely
which router behaviours must remain hand-built and stops there.* It did not. Three independent
reasons, any one of which is sufficient:

1. **The canonical router is Erlang (ADR-0004), and LiteLLM is a Python library.** There is no
   way to embed it in `provider-router-erl/`. Adopting it inside the Python router alone would
   break the very equality `apr_conformance_SUITE` exists to assert — the suite demands the two
   surfaces agree *byte for byte*, key order and float spelling included.
2. **The corpus asserts behaviours LiteLLM does not implement.** `python-surface.json` pins two
   environments: bare (every modality falls to the placeholder) and keyed (a ceiling of zero
   refuses the paid rung *without dialing it*). Those are N1 and N4 — the two NOT COVERED
   needs. A LiteLLM-backed path would have to reproduce them from agora code anyway, so the
   corpus is asserting agora's logic no matter what sits underneath.
3. **The Erlang router is more than a model gateway.** Beyond the shared contract routes it
   serves `/v1/subscribe` and `/v1/assets/:id` and carries `apr_bus`, `apr_grant`, `apr_events`
   and `apr_translate`. LiteLLM is not in that category and does not claim to be.

**US-3 is therefore redefined to documentation only** — this section is that documentation.
The behaviours that must remain hand-built, and the corpus that must keep asserting them:

| Must remain hand-built | Asserted today by |
|---|---|
| The terminal placeholder rung; `complete` never raises on runtime state | `tests/test_zero_spend.py`, `apr_conformance_SUITE` bare surface, `apr_placeholder*.erl` |
| Per-request `budget_units` / `X-Agora-Budget-Units`, skip-without-dialing, `Attempt.dialed` | `tests/test_budget.py`, `apr_conformance_SUITE` keyed surface, `apr_cost.erl` |
| `unpriced` never passes a ceiling; `budget_units` denomination; non-text `measure()` | `tests/test_cost.py`, `apr_cost.erl` |
| The AgentCard + KCB manifest extension and its resolved-tier `cost` | `tests/test_manifest.py`, `apr_manifest.erl`, `schemas/` |
| `/v1/audio/music-generations` | both routers' route tables |
| The bus half (`/v1/subscribe`, `/v1/assets/:id`) | `provider-router-erl/` only |

Nothing in the conformance corpus is left asserting a code path that no longer runs, because
no code path is being retired.

---

## 5. Recommendation

Adopt LiteLLM **as a dispatch adapter for the paid tier**, not as the gateway. The ladder, the
ceiling, the placeholder, the cost model and the KCB manifest are agora's differentiators and
the spike found no LiteLLM mechanism for any of them; what it did find is a maintained answer
to the one problem the router punts on today — seven vendors it can name but cannot dial.

If the dependency weight (86 requires-dist, ~166 MB) outweighs five new dialable vendors for a
given deployment, the alternative that costs nothing is to keep LiteLLM's **price map** as an
`AGORA_PRICE_TABLE` source and write the two or three adapters by hand. Recording that as a
live option is part of the spike's answer: the swap is worth doing for the adapters alone, and
worth doing *only* for the adapters.

---

## Appendix — transcript

Reproduce with `./docs/spikes/litellm-leaf/run.sh` (builds a scratch venv under `$TMPDIR`;
LiteLLM is deliberately **not** a `provider-router/` dependency — that is what US-2 decides).
Every request below is offline: the "paid" rungs are either LiteLLM's `mock_response` or a
base URL on `127.0.0.1:1`, where nothing listens, so a connection error proves which address
was dialed. Lines marked `!!` are findings that contradict a reasonable assumption.

```
litellm 1.95.0

EXPERIMENT 1 openai-surface — an OpenAI-compatible request, no key, no network
  -> choices[0].message.content = 'hello'
  -> model=gpt-4o-mini object=chat.completion total_tokens=30
  -> completion_cost = $1.35e-05

EXPERIMENT 2 placeholder-provider — the zero-spend terminal rung as a CustomLLM
  -> content = '[placeholder:text] deterministic'
  -> usage.total_tokens = 0 (nothing to bill)
  -> handler dialed 1 time(s); no socket was opened
  !! completion_cost('agora-placeholder/text') raised Exception: This model isn't mapped yet.
     model=agora-placeholder/text, custom_llm_provider=agora-placeholder. — a custom provider
     is unpriced unless registered

EXPERIMENT 3 always-completes-fallback — paid rung unreachable, placeholder answers
  -> asked for agora-text, served by 'agora-placeholder/text': '[placeholder:text] deterministic'
  -> the unreachable paid rung errored and the fallback chain continued — no exception
  !! the chain is terminal only because the LAST entry cannot fail; LiteLLM has no notion of a
     rung that must always answer, so agora owns that guarantee either way

EXPERIMENT 4 mlx-tier — an OpenAI-compatible self-hosted server at a configured base URL
  -> get_llm_provider('openai/mlx-community/Qwen3-8B-4bit') -> provider='openai'
  -> dialing the configured base URL failed as expected: InternalServerError
  -> mlx-serve needs no adapter: it is `openai/<model>` + api_base, exactly as today

EXPERIMENT 5 local-ollama-tier — a first-class LiteLLM provider
  -> get_llm_provider('ollama_chat/llama3.2') -> provider='ollama_chat'
  -> dialing the configured base URL failed as expected: APIConnectionError

EXPERIMENT 6 cost-estimation — pricing a rung BEFORE it is dialed
  -> token_counter(gpt-4o-mini, prompt) = 8
  -> cost_per_token(gpt-4o-mini) -> $0.00061560 projected
  -> cost_per_token(groq/llama-3.3-70b-versatile) -> $0.00081368 projected
  -> 'ollama/llama3.2' in the built-in cost map: False
  !! cost_per_token('ollama/llama3.2') = (0, 0) for an UNMAPPED model — LiteLLM's estimator
     says 'free' where it means 'unknown'. agora's `unpriced` flag (cost.rate_for) exists
     precisely so that cannot pass a ceiling
  -> cost_per_token('mlx-community/Qwen3-8B-4bit') raised BadRequestError — the keyless tiers
     are absent from the built-in map; a rate must be DECLARED per deployment
  -> declaring one: litellm_params={'input_cost_per_token': 0.0, 'output_cost_per_token': 0.0}
  -> after Router registration, cost_per_token(openai/mlx-community/Qwen3-8B-4bit) = (0.0, 0.0)
  -> an unmapped model raises (Exception) rather than pricing 0 — LiteLLM fails loud, but at
     SETTLE time, not as a routing signal

EXPERIMENT 7 budget-ceiling-global — what litellm.max_budget actually does
  -> completion() budget-ish parameters: []
  -> Router.acompletion parameters: ['self', 'model', 'messages', 'stream', 'kwargs']
  !! there is NO per-request spend ceiling parameter anywhere on the call surface
  -> with _current_cost=0 the call proceeds (the ceiling is checked against spend so far)
  -> with _current_cost=5.0 > max_budget=0.01: BudgetExceededError: Budget has been exceeded!
     Current cost: 5.0, Max budget: 0.01
  !! it ABORTS the request. It does not fall through to a cheaper rung — and it is a
     process-global CUMULATIVE ceiling, not the caller's per-request one

EXPERIMENT 8 budget-ceiling-per-request — the shim agora must keep, and its proof
  -> paid         projected $0.010320 vs ceiling $0.000000 -> SKIPPED (over ceiling, not dialed)
  -> placeholder  projected $0.000000 vs ceiling $0.000000 -> affordable
  -> served by 'agora-placeholder/text': '[placeholder:text] deterministic'
  -> paid rung dialed 0 time(s) — PROVEN SKIPPED
  !! this filter is ~10 lines and lives OUTSIDE LiteLLM: the ladder order is a preference, the
     ceiling is a constraint, and LiteLLM models neither as a pre-dial refusal
  -> for contrast, LiteLLM's own cost strategy RANKS but never refuses:
  -> cost-based-routing picked 'llama-3.3-70b-versatile' (the cheaper of two PAID rungs)

EXPERIMENT 9 modality-surface — which of agora's five modalities LiteLLM speaks
  -> text   litellm.acompletion          present
  -> image  litellm.aimage_generation    present
  -> speech litellm.aspeech              present
  -> video  litellm.avideo_generation    present
  -> music  litellm.amusic_generation    ABSENT
  !! music has no LiteLLM surface at all — /v1/audio/music-generations is agora's own route
     over its own vendors and stays hand-built

all experiments ran
```
