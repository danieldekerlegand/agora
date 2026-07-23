# provider-router

A gateway to **model backends** — OpenAI-compatible, always-completes. One leaf capability on
the KCB bus, **not** the path other platforms route through (ADR-0001 decision 1).

The tier ladder is ported from Analyzer's "sacred ladder" (`~/Development/analyzer`,
`src/filmstudio/core/ladders.py`). Per modality, in order:

1. **paid** — a configured API key
2. **mlx-serve** — `MLX_SERVE_BASE_URL`
3. **local** — Ollama / on-disk weights
4. **placeholder** — deterministic, free

An unavailable tier falls through to the next, so with no keys and no local servers every
modality still resolves — the ZERO-SPEND / always-completes invariant. It is a *test*, not a
comment: `tests/test_zero_spend.py` asserts that a bare environment resolves every modality to
the placeholder, that nothing is dialed, and that no call raises.

## Run it

Standalone — no repo-root Makefile, no sibling areas. Install the package and launch the
console entry point (or the module runner); both boot the FastAPI app under uvicorn, reading
`AGORA_HOST` (default `0.0.0.0`) and `AGORA_PORT` (default `8000`) from the environment:

```sh
pip install agora-provider-router          # or: uv pip install agora-provider-router
agora-provider-router                       # the [project.scripts] console entry point
# equivalently:
python -m agora_provider_router
```

**A fresh install is safe to run immediately.** With no API keys and no local servers
configured, every modality resolves to the deterministic placeholder tier — the
always-completes / ZERO-SPEND default. It answers requests and spends nothing; add a key
(below) only when you want a paid tier.

From a checkout, uv runs it against the source tree instead:

```sh
uv run agora-provider-router                             # from provider-router/
# or the app directly under uvicorn with reload:
uv run uvicorn agora_provider_router.app:app --reload
curl localhost:8000/doctor                               # the resolved ladder per modality
curl localhost:8000/health                               # liveness + identity + kcb_version
```

### Build the wheel

```sh
uv build                                                 # from provider-router/ → dist/*.whl
```

The shipped price sheet (`prices.toml`) is packaged as data, so a wheel installed into a
clean venv prices the ladder without reaching back into the repo.

## Surface

| Route | What |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat completions (modality `text`) |
| `POST /v1/images/generations` | modality `image` |
| `POST /v1/audio/speech` | modality `speech` |
| `POST /v1/audio/music-generations` | modality `music` |
| `POST /v1/video/generations` | modality `video` |
| `GET /v1/models` | every model the ladder can currently resolve to |
| `GET /v1/providers` | the vendor vocabulary (preference order, wire format) |
| `GET /doctor` | the resolved ladder per modality — dials nothing |
| `GET /health` | liveness + identity |
| `GET /.well-known/kcb-manifest.json` | the KCB capability manifest (KCB §2) |

Every generation response is the backend's body **verbatim** plus an `agora` key — the resolved
tier, provider, model, the rungs that were tried, and the projected/actual cost — mirrored into
`X-Agora-Tier` / `X-Agora-Provider` / `X-Agora-Model` / `X-Agora-Cost-Units`. An OpenAI client
ignores the extra key; the conformance console (US-AG5) reads it to show which tier served a
request and what it cost.

## Budget ceilings

A request may carry a spend ceiling in KCB **budget units** (`capability-bus.md` §5) — as
`budget_units` in the body, or as `X-Agora-Budget-Units` for a stock OpenAI SDK that will not let
you add an unknown body key. The body wins; the key is stripped before dispatch so it never
reaches an upstream provider.

```sh
curl localhost:8000/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1000,"budget_units":0}'
# → served by the placeholder; the paid rung was never contacted
```

The ladder order is a **preference**; the ceiling is a **constraint**. Each rung is priced before
it is dialed, and one projected over budget is refused *without being contacted* — so the walk
falls through to a cheaper, ultimately zero-cost rung. A ceiling of `0` therefore cannot spend at
all. Where the ladder expresses no preference — two usable paid vendors — the cheaper one wins
(KCB §3, "path search prefers zero-cost routes").

Rates live in `cost.py`, denominated in budget units (anchored at 1 unit = US$0.00001) because a
grant travels between projects that share no billing account. They are **conservative estimates,
not quotes**; override any of them with `AGORA_PRICE_<MODALITY>_<PROVIDER>` (e.g.
`AGORA_PRICE_VIDEO_RUNWAY=4000`). Two rules the code enforces:

- **An unpriceable rung never passes a ceiling.** A vendor with no published rate is flagged
  `unpriced` and refused whenever a ceiling is set — "we don't know" must not read as "free", or
  an unknown vendor becomes the cheapest route in the ladder.
- **A ceiling only ever fails safe.** A negative one clamps to zero; an unreadable one is a `422`,
  not a silently-unbudgeted request. Dropping it would turn a typo into unlimited spend authority.

## Capability manifest

`GET /.well-known/kcb-manifest.json` is the router's KCB manifest (§2) — the first concrete one in
the ecosystem, and what the registry (US-AG4) indexes. It declares the KINP identity, the
endpoints it serves, the ports it produces/consumes across planes (§2.1: text in, media out), and
one invocable capability per modality carrying a `cost`.

That cost is advertised for the tier that is **currently resolved**: a keyless router publishes
`{"tier": "placeholder", "est_units": 0}`, the same binary with a key publishes the paid rate.
Publishing a static price list would make the registry's zero-cost preference a lie on exactly
the deployments where it matters most. Each figure is priced against a fixed nominal request,
stated in `cost.basis`, so two providers' numbers are comparable.

No endpoint is advertised that is not served — MCP and A2A addresses are absent until they exist,
because a manifest address is a promise the registry hands to peers who then dial it **directly**
(ADR-0001 decision 3), and a dead one is worse than an absent one.

## Configuration

Provider settings use the ecosystem's `CUNEIFORM_PROVIDER_<NAME>_<FIELD>` shape (`API_KEY`,
`BASE_URL`, `MODEL`, `ENABLED`), so an `.env` written by a Orchestrator/Analyzer console configures
this router unchanged. The common non-namespaced spellings (`OPENAI_API_KEY`,
`MLX_SERVE_BASE_URL`, `OLLAMA_HOST`, …) are accepted; the namespaced form wins. Settings are
read from the process environment and, under it, `$CUNEIFORM_ENV_FILE` (default `./.env`) — an
explicit `export` beats the file.

| Variable | Effect |
|---|---|
| `CUNEIFORM_PROVIDER_OPENAI_API_KEY` | enables the paid tier for the modalities OpenAI serves |
| `MLX_SERVE_BASE_URL` | enables the mlx-serve tier |
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | enables the local tier |
| `AGORA_<MODALITY>_LADDER` | narrows/reorders that modality's tiers, e.g. `local,mlx` |
| `AGORA_PREFER_LOCAL=1` | fronts the zero-spend tiers everywhere |
| `AGORA_PRICE_<MODALITY>_<PROVIDER>` | overrides a rate, in budget units per unit |
| `AGORA_PUBLIC_BASE_URL` | the address the KCB manifest publishes for itself |
| `CUNEIFORM_ENV_FILE` | the env file to read provider settings from |

Three rules the code enforces rather than documents:

- **The placeholder is not a ladder token.** `AGORA_TEXT_LADDER` can narrow *which* backends are
  tried; it can never remove the terminal tier. A bad value degrades to the default order and is
  reported by `/doctor` instead of aborting.
- **Secrets never leak.** Keys are `SecretStr` and a config keeps only the `AGORA_*` variables,
  so no repr, log line or response body can carry one — including the failure reasons on
  `/doctor`, which have the backend's own key redacted out.
- **A key on disk is 0600.** An env file holding secrets at looser permissions is tightened in
  place on load, and the fact is reported by `/doctor`.

A local tier is used only when its base URL is **configured** — the router never probes a
default localhost port, because "no local servers" must not depend on what happens to be
listening on the box.

Paid vendors whose HTTP surface is not OpenAI-shaped (Anthropic, Gemini, Replicate, ElevenLabs,
the video houses) are recognised and ranked but resolve to `pending-adapter`: they are reported
by `/doctor` and fall through rather than being dialed with a wire format they do not speak.
Per-vendor adapters are a later story.

## Gate

```sh
make check-provider-router      # from the repo root
```

which is:

```sh
uv sync --extra dev
uv run ruff check .
uv run mypy
uv run pytest -q
```

### Standalone (no sibling areas)

Three tests are cross-language pins that reach up to sibling TS areas — the KCB version
against `schemas/`, and the captured session/manifest fixtures the `console/` and
`registry/` gates replay. In the full monorepo they RUN and hold those guards; in an
extracted checkout that contains only `provider-router/` they **skip cleanly** (they never
error or fail) because the sibling paths are absent. To prove the package suite is green on
its own — built, installed into a clean venv, and run with no sibling area present:

```sh
provider-router/scripts/standalone-test.sh    # builds the wheel, installs it, runs pytest
```

It reports `... passed, 4 skipped` — the four cross-repo guards are the skips.

## Status

The ladder, the OpenAI-compatible surface and `/doctor` are in (US-AG2); budget ceilings and the
KCB capability manifest are in (US-AG3). Next: the registry indexes this manifest (US-AG4) and the
conformance console runs a round-trip through it (US-AG5).
