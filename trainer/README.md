# trainer

agora's **general finetune trainer** — the runtime implementation of the koine fine-tuning
profile (KFT, `../../koine/specs/fine-tuning.md`). One leaf capability on the KCB bus: it
consumes training data (KGP knowledge / KMI media) plus a base-model entity (KINP) and produces
a new model entity (KINP) plus weight assets (KMI), advertised as the `finetune` capability
(KCB §2, KFT §2).

**Distinct from the provider-router, never merged** (ADR-0001 decision 1). The provider-router
routes *inference* to model backends; the trainer runs long-lived, stateful, GPU *fine-tuning*
jobs. They share the bus, not a process — this package imports nothing from
`agora_provider_router`.

## What it advertises (US-1)

One `finetune` capability per KFT §3.1 modality (`text-generation`, `image-text-to-text`,
`video-text-to-text`, `text-to-image`, `text-to-video`), each with plane-typed ports:

- **in** — a `model`/entity base-model port + a `knowledge` and/or `media` training-set port,
- **out** — a `model`/entity finetuned-model port + a `media` weights port
  (`application/vnd.koine.model+safetensors` / `+gguf`, KFT §5.3),
- **cost** — metered in `gpu-seconds` (KFT §2/§7); the static figure is nominal, the real gate is
  the admission-time per-job estimate (FT-E, US-3).

The modality rides the entity ports' `types` (the §5.1 model-entity refinement), so the registry
finds the trainer both by capability name `finetune` and by modality.

## Admission, engines & telemetry (US-2)

`invoke` (`POST /invoke`, KCB §4) admits a finetune job, then streams the KFT §6
training-telemetry over the same request:

- **Admission** validates the payload against the vendored `finetune-job.schema.json` (KFT §3;
  the copy under `src/agora_trainer/schemas/` is pinned byte-for-byte to koine) and then checks
  the `modality × method` combination (KFT §3.1, FT-F) — an incompatible pair (e.g.
  `dpo × text-to-image`) is rejected *before* any engine runs. The verdict is a structured report
  with exit-code semantics matching agora's validators: **0** ok / **1** invalid / **2** usage —
  over the CLI (`agora-trainer-validate <job.json>`) and mirrored to HTTP (200 / 422 / 400).
- **Engine ladder** (KFT §9): an admitted job is dispatched by `modality × method` to an engine
  adapter (`prepare_data → launch → emit_telemetry → export`). US-2 wires the **LLaMA-Factory**
  rung (`text-generation` × {sft, lora, qlora}); a compatible-but-unwired modality (e.g.
  `text-to-image`, US-4's diffusers rung) is an honest `501`, distinct from a rejection.
- **Telemetry** (KFT §6): one event per training step in monotonic order, content-addressed by
  `job + step` so redelivery is idempotent, closed by a terminal event carrying the minted
  finetuned-model id + weight/export asset ids. Where no GPU / LLaMA-Factory is present the
  adapter replays a **recorded run** (real per-step logs), never a fabricated loss curve.

Still to come: the egress-gated SkyPilot placement + spend gating (US-3), the multimodal adapter
+ model/weight artifacts with lineage & inheritance (US-4), and multi-provider registry routing
(US-5).

## Run it

Standalone — no repo-root Makefile, no sibling areas. Install the package and launch the console
entry point (or the module runner); both boot the FastAPI app under uvicorn, reading
`AGORA_TRAINER_HOST` (default `0.0.0.0`) and `AGORA_TRAINER_PORT` (default `8001`, one above the
provider-router's) from the environment:

```sh
pip install agora-trainer            # or: uv pip install agora-trainer
agora-trainer                        # the [project.scripts] console entry point
# equivalently:
python -m agora_trainer
```

It serves `/health`, the A2A agent card at `/.well-known/agent-card.json`, and the KCB manifest
at `/.well-known/kcb-manifest.json` — exactly the endpoints the manifest advertises, and only
those (ADR-0001 decision 3).

## Gate

```sh
make check-trainer    # ruff check + ruff format --check + mypy --strict + pytest
```
