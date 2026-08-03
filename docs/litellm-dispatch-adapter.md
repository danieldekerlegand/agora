# The LiteLLM dispatch adapter — what agora delegated, and what it kept

**Status:** landed (US-2). **Follows:** [the US-1 spike](spike-litellm-leaf.md), whose verdict
for this story was *GO, NARROWED*. **Code:**
`provider-router/src/agora_provider_router/litellm_dispatch.py`.
**Tests:** `provider-router/tests/test_litellm_dispatch.py`.

The spike asked whether an off-the-shelf OpenAI-compatible gateway could replace the
provider-router. The answer was no, and the reason was specific: of the three differentiators
the tasklist named as must-survive — the always-completes zero-spend placeholder rung,
per-request budget ceilings that skip a tier *without dialing it*, and exposure as a KCB
capability — LiteLLM has a mechanism for none. What it does own is **vendor wire adapters**,
which is precisely the one thing this router punts on.

So US-2 is not a swap. It is a **borrow**, kept behind a boundary that already existed: the
injected `Transport`.

## What was delegated

Exactly the paid-tier vendors `backends.py` declares with `wire="native"` — the ones whose
HTTP surface is not OpenAI-shaped, which the router could name, rank and report but never
dial. They resolve to `pending-adapter` because sending them OpenAI JSON would be a fake tier
that fails on every real request. With the adapter on, the covered ones become real rungs.

Nothing else. The OpenAI-wire paid vendors, mlx-serve and Ollama are one OpenAI POST already;
routing them through a second abstraction would buy nothing and would add a translation that
can disagree with `ENDPOINTS`.

## What was kept hand-built — the keep-decision US-2's gate asks for

| Kept | Because the spike found | Asserted by |
|---|---|---|
| The terminal placeholder rung and the always-completes invariant | **N1 NOT COVERED** — LiteLLM's fallback chain terminates only because agora's last entry cannot fail; it has no notion of a rung that must always answer | `tests/test_zero_spend.py`, `TestTheExtraIsOptional` |
| The per-request ceiling, refused **before** the rung is dialed (`Attempt.dialed`) | **N4 NOT COVERED** — LiteLLM's four budget primitives are cumulative and *abort*; its cost strategy ranks but never refuses | `tests/test_budget.py`, `TestTheCeilingStillRefuses` |
| `cost.py` — the `unpriced` rule, `budget_units` denomination, non-text `measure()` | **N5 NOT COVERED** for its two safety rules — `cost_per_token` returns `(0, 0)` for an unmapped model, i.e. *free* where it means *unknown* | `tests/test_cost.py` |
| The AgentCard and its KCB manifest extension | **N6 NOT COVERED** — LiteLLM's A2A support is a *client*; it publishes nothing about itself | `tests/test_manifest.py`, `schemas/` |
| `/v1/audio/music-generations` | **N7** — LiteLLM has no music surface at all | both routers' route tables |

The adapter sits *below* every one of these. A rung over the ceiling is refused before the
transport is reached, so turning the adapter on cannot make a zero-budget request spend
anything — which is a test (`TestTheCeilingStillRefuses`), not a claim: it counts the calls
the stand-in LiteLLM received, the same shape of proof as the spike's experiment 8.

## Which vendors actually became dialable — two, not five

The spike reported LiteLLM adapters for five of the seven native-wire vendors. That count is
right about LiteLLM and wrong about agora: coverage has to line up with the **modality this
router routes each vendor for** (`PAID_PROVIDERS`), and on that test only two survive.

| vendor | agora routes it for | outcome |
|---|---|---|
| **anthropic** | text | **dialable** — `anthropic/` chat |
| **gemini** | text | **dialable** — `gemini/` chat |
| replicate | image, music | gap — LiteLLM prices replicate for *chat* only |
| minimax | video | gap — LiteLLM covers its chat and speech, not video |
| elevenlabs | speech | gap — `litellm.aspeech` answers with a binary stream, and `/v1/audio/speech` relays a JSON body |
| runway | video | gap — no LiteLLM adapter |
| luma | video | gap — no LiteLLM adapter |

Recording that correction is the point of the anti-fabrication rule this tasklist carries: an
uncovered vendor keeps resolving to `pending-adapter`, which is an honest refusal, rather than
being forced through a translation nobody verified. Widening the table is a one-line change
plus the test that proves the pair round-trips.

## Off by default, for two reasons

`AGORA_LITELLM=1` switches it on and LiteLLM is an optional extra
(`pip install 'agora-provider-router[litellm]'`).

1. **Weight.** 86 declared dependencies and ~166 MB, for two new dialable vendors. That is a
   deployment's call, not the package's. Nothing imports LiteLLM unless the variable is set;
   the import is lazy, and if the extra is missing the rung fails with an actionable message
   and the walk continues — an uninstalled optional dependency degrades the ladder, it never
   denies service.
2. **The byte-for-byte corpus.** The canonical router is Erlang (ADR-0004), and
   `apr_conformance_SUITE` asserts the Erlang and Python surfaces answer with *identical
   bytes*. LiteLLM is a Python library with no Erlang half, so the Python router's **default**
   surface has to stay exactly what it was. Keying the adapter off an `AGORA_*` variable —
   which that suite scrubs before every case — is what keeps the corpus a function of the
   fixture rather than of the capturing host. Verified: re-running
   `capture_python_surface.py` after this change reproduces `python-surface.json` byte for
   byte.

## Using it

```sh
pip install 'agora-provider-router[litellm]'
export AGORA_LITELLM=1
export ANTHROPIC_API_KEY=sk-ant-...        # or GEMINI_API_KEY / GOOGLE_API_KEY
agora-provider-router
curl localhost:8000/doctor                  # the anthropic rung now reads "ready"
```

The default models (`claude-sonnet-4-5`, `gemini-2.5-flash`) are declared in `PAID_VENDORS`
so enabling a vendor is one variable rather than three;
`AGORA_PROVIDER_<NAME>_MODEL` overrides either, and a model id ages faster than a vendor does.
`AGORA_PROVIDER_<NAME>_BASE_URL` is passed through to LiteLLM as `api_base` when set — but
only when explicitly set, since LiteLLM knows each vendor's own address and the default in
`PAID_VENDORS` is vocabulary for `/v1/providers` rather than something this router dials.

Everything else is unchanged: the same ladder order, the same `budget_units` ceiling, the same
routing report, the same AgentCard.

## What US-3 does with this

Nothing. The spike's verdict for US-3 was **NO-GO** and the reasons are unaffected by this
story — if anything they are reinforced. The adapter adds vendors *below* the transport
boundary; the behaviours the dual Erlang/Python router encodes, and that the conformance
corpus pins, are all above it and all still hand-built. See §4 of the spike report, and
[`router-hand-built-behaviours.md`](router-hand-built-behaviours.md) for the inventory US-3
landed: every kept behaviour, its module on both sides, and the assertions that hold it.
