# The LiteLLM dispatch adapter — what agora delegated, and what it kept

**Status:** landed (US-2). **Follows:** [the US-1 spike](spike-litellm-leaf.md), whose verdict
for this story was *GO, NARROWED*. **Code:**
`provider-router/src/agora_provider_router/litellm_dispatch.py`.
**Tests:** `provider-router/tests/test_litellm_dispatch.py`.

> ## ⚠️ Scope correction — 2026-08-11
>
> **This adapter is scoped to the superseded Python router only. The canonical router contains
> no LiteLLM at all** — no dependency in `rebar.config`, no import, no dispatch path. The name
> survives under `provider-router-erl/` in four files and comments only — `apr_cost.erl`,
> `apr_backends.erl`, `apr_conformance_SUITE.erl`, `apr_local_backend_tests.erl` — every
> occurrence an attributed reference to the *Python* side or to this document. No code, no
> configuration and no test assertion stands behind any of them.
>
> The canonical Erlang router (ADR-0004) dials **all seven** native-wire vendors — anthropic,
> gemini, replicate, elevenlabs, runway, luma, minimax — through the **Rust port program**
> [`translation/crates/wire`](../translation/crates/wire), built by
> [`provider-router-erl/build-translator.sh`](../provider-router-erl/build-translator.sh) and
> driven by [`apr_translate.erl`](../provider-router-erl/src/apr_translate.erl) as a supervised
> external OS process.
>
> **A port, not a NIF, and that is the point.** That rationale is not re-argued here; it is
> quoted from where it is enforced, the module doc of `apr_translate.erl`:
>
> > The router's invariant is that no rung can take down the node. A NIF runs inside the BEAM's
> > address space, where a panic or a segfault in third-party wire-format code would be exactly
> > the failure the sacred ladder exists to make impossible; "fail-safe" would be a claim about
> > the Rust rather than a property of the design. An OS process cannot do that. Here the worst
> > case costs one pipe: the port dies, `handle_info/2` clears it, this call answers
> > `{error, _}`, the rung worker records an undialed attempt and the walk continues to a
> > cheaper — ultimately zero-cost — rung. Always-completes and ZERO-SPEND hold with the
> > translator absent, crashed, hung or wrong.
>
> Read that module doc, not this paragraph, if the two ever drift: *always-completes* is a
> structural property of an OS-process boundary, not a claim about someone else's code.
>
> That makes the coverage picture the **opposite** of what the rest of this document implies:
> the Rust codec covers **8 `(vendor,modality)` pairs across all seven native-wire vendors**,
> where this adapter makes **2 of 7 vendors** dialable (anthropic and gemini, text only). The
> canonical path is **ahead** of the borrowed one — 8 pairs to 2 — not behind it, and the
> vendor-breadth path of record is `chief/52-wire-codec-vendor-breadth`.
>
> **The code is right; the record was wrong.** Two independent reasons to keep it that way —
> LiteLLM cannot embed in the BEAM without giving up a differentiator, and it has a
> compromised-release history on PyPI — are argued in full, with the pin they imply, under
> [*Why this stays a Python-side borrow*](#why-this-stays-a-python-side-borrow--the-two-reasons-the-code-is-right)
> below.
>
> Everything below remains accurate **for the Python router**. `chief/69` carries the full
> correction across the docs, including `agentjido/req_llm` as the untried option for
> canonical-side breadth.

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

## Why this stays a Python-side borrow — the two reasons the code is right

The scope correction above says the record was wrong. This section says why the **code** was
right, so the question does not get re-litigated from scratch by the next reader who notices that
a maintained multi-provider library exists. Two reasons, and neither depends on the other.

### 1. LiteLLM cannot embed in the BEAM without costing a differentiator

The canonical router is Erlang (ADR-0004). LiteLLM is a Python library, so there are exactly two
ways to put it on the canonical dispatch path, and each one spends something the router exists
for.

**As a NIF** — which for a Python library means an embedded CPython inside the BEAM's own address
space — it lands on the wrong side of the boundary `apr_translate.erl` exists to hold. The module
doc quoted above is the whole argument: a fault in third-party code becomes a fault *of the node*,
and *always-completes* stops being a structural property of an OS-process boundary and becomes a
claim about somebody else's code. Nothing about that argument is weaker for Python than for Rust;
it is stronger, because a Python rung also drags an interpreter, a GIL and an import graph inside
the node, and a blocking call there holds a scheduler thread instead of yielding it.

**As a Python sidecar** the node is safe again — a sidecar *is* a port, the shape agora already
uses — but the cost moves rather than disappearing, and where it lands depends on how much of
LiteLLM you actually use:

* Used as a **pure wire-format translator**, it is safe and redundant. That is precisely what
  [`translation/crates/wire`](../translation/crates/wire) already does, for eight
  `(vendor,modality)` pairs against LiteLLM's two — and it would be doing the smaller job with a
  Python interpreter, 86 declared dependencies and ~166 MB on the request hot path, plus the
  supply-chain surface reason 2 is about.
* Used as **itself** — its router, its fallback chain, its cost accounting, the parts that make
  adopting it worth anything — the dispatch decision moves into a component with different rules.
  It has no terminal rung that cannot fail (its fallback chain terminates only because agora's
  last entry cannot), and `cost_per_token` answers `(0, 0)` for a model it has no rate for: **free
  where agora means unknown**, which is fail-**open** exactly where the `unpriced` rule refuses.
  Per-request, caller-supplied refusal taken *before the rung is dialed* survives only while that
  decision stays above the transport boundary, which is the boundary a sidecar would sit below.

Be precise about which half of that is still load-bearing: a hard budget **ceiling** on its own is
no longer a differentiator — LiteLLM ships dollar-denominated pre-call budgets with
`fail_closed_budget_enforcement`, and `chief/71-budget-differentiator-honesty` re-dates the
spike's N4 finding rather than deleting it. What survives is the `unpriced`-never-passes rule, the
`budget_units` denomination, non-text `measure()`, and the always-completes terminal rung.

There is also a directional cost that is not about mechanism at all: giving the canonical Erlang
router a Python process on its request path reverses the ADR-0004 cutover it is in the middle of.

### 2. Supply chain — optional, floored and off, for a reason with a date on it

**LiteLLM 1.82.7 and 1.82.8 were backdoored on PyPI in March 2026.** (An incident in the
dependency, not in agora's use of it — see below: this router has never been able to resolve
either release. Recorded here from the 2026-08 prior-art sweep and `ROADMAP.md` Phase B; it is a
claim about an upstream package, so re-verify it upstream before citing it anywhere that matters.)

An unpinned dependency on a request hot path with a compromised-release history is disqualifying.
So this extra stays **optional**, **version-floored** and **off** unless `AGORA_LITELLM=1` — a
third reason for that posture, standing alongside the weight and byte-for-byte-corpus ones
above.

The consequence, made concrete rather than left as a moral — checked 2026-08-13:

| | |
|---|---|
| The constraint | `litellm = ["litellm>=1.95"]`, in [`provider-router/pyproject.toml`](../provider-router/pyproject.toml) |
| Does it exclude the backdoored releases? | **Yes** — `1.95 > 1.82.8`, so neither is resolvable, and neither ever was. |
| Enforced, or incidental? | Enforced. `TestTheFlooredExtraExcludesTheBackdooredReleases` in `provider-router/tests/test_litellm_dispatch.py` reads the extra out of `pyproject.toml` and fails if the floor is ever dropped past 1.82.7/1.82.8. |
| Why no explicit `!=1.82.7,!=1.82.8`? | It would restate in metadata what the test already refuses to let drift, and it would churn the lockfile for a constraint that changes no resolution (verified: editing the specifier rewrites `uv.lock`'s `requires-dist` line). The floor is the pin; the test is what keeps it one. |
| What an install actually gets | `provider-router/uv.lock` resolves 1.95.0 with per-artifact `sha256` hashes, so enabling the extra installs hash-checked. |

Neither reason is an argument against *breadth*. The untried candidate for canonical-side vendor
breadth is `agentjido/req_llm`, which is native BEAM and so pays neither of these costs; `chief/69`
US-3 records it, with its facts and what adopting it would have to be judged on, in
[`prior-art.md`](prior-art.md).

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
