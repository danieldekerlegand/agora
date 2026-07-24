# Self-contained image for the agora trainer (US-1).
#
# The build context is trainer/ alone: nothing below reaches into the sibling areas
# (provider-router/, schemas/, registry/) or the repo-root Makefile, so
#
#   docker build -t agora-trainer trainer/
#   docker run -p 8001:8001 agora-trainer
#
# is the whole deploy. A bare container serves /health, the A2A agent card, and the KCB
# manifest — what the registry crawls to discover the trainer (KCB §3).

# --- build: produce the wheel -----------------------------------------------------
FROM python:3.11-slim AS build
WORKDIR /build
# Only what the wheel declares it needs — pyproject, the README it names as `readme`, and
# the package source. hatchling is fetched by pip's build isolation.
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /dist .

# --- runtime: install the wheel + its deps, drop build tooling --------------------
FROM python:3.11-slim AS runtime
# A non-root service account; the trainer needs no write access to its own tree.
RUN useradd --create-home --uid 10001 agora
COPY --from=build /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm -f /tmp/*.whl
USER agora

# The entry point reads AGORA_TRAINER_HOST / AGORA_TRAINER_PORT; bind all interfaces on 8001.
ENV AGORA_TRAINER_HOST=0.0.0.0 \
    AGORA_TRAINER_PORT=8001
EXPOSE 8001

# The [project.scripts] console entry point — the same target as `python -m agora_trainer`,
# booting app.py under uvicorn.
CMD ["agora-trainer"]
