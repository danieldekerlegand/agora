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

```sh
uv run uvicorn agora_provider_router.app:app --reload    # from provider-router/
curl localhost:8000/doctor                               # the resolved ladder per modality
```

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

Every generation response is the backend's body **verbatim** plus an `agora` key — the resolved
tier, provider, model and the rungs that were tried — mirrored into `X-Agora-Tier` /
`X-Agora-Provider` / `X-Agora-Model`. An OpenAI client ignores the extra key; the conformance
console (US-AG5) reads it to show which tier served a request.

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

## Status

The ladder, the OpenAI-compatible surface and `/doctor` are in (US-AG2). Budget ceilings and the
KCB capability manifest land in US-AG3.
