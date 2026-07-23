# Self-contained image for the agora provider-router (US-5).
#
# It builds the wheel and runs the US-4 console entry point. The build context is
# provider-router/ alone: nothing below reaches into the sibling TS areas (schemas/,
# console/, registry/) or the repo-root Makefile, so
#
#   docker build -t agora-provider-router provider-router/
#   docker run -p 8000:8000 agora-provider-router
#
# is the whole deploy. A bare container — no keys, no local servers — resolves every
# modality to the deterministic placeholder tier: it answers /doctor and the KCB
# manifest and spends nothing (the always-completes / ZERO-SPEND default).

# --- build: produce the wheel (with its packaged prices.toml) ---------------------
FROM python:3.11-slim AS build
WORKDIR /build
# Only what the wheel declares it needs — pyproject, the README it names as `readme`,
# and the package source. hatchling is fetched by pip's build isolation.
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /dist .

# --- runtime: install the wheel + its deps, drop build tooling --------------------
FROM python:3.11-slim AS runtime
# A non-root service account; the router needs no write access to its own tree.
RUN useradd --create-home --uid 10001 agora
COPY --from=build /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm -f /tmp/*.whl
USER agora

# The entry point reads AGORA_HOST / AGORA_PORT (US-4); bind all interfaces on 8000.
ENV AGORA_HOST=0.0.0.0 \
    AGORA_PORT=8000
EXPOSE 8000

# The [project.scripts] console entry point — the same target as `python -m
# agora_provider_router`, booting app.py under uvicorn.
CMD ["agora-provider-router"]
