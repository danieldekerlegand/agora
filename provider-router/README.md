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
modality still resolves — the ZERO-SPEND / always-completes invariant.

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

Skeleton (US-AG1): package, config, `/health`. The ladder lands in US-AG2, budget ceilings and
the KCB manifest in US-AG3.
