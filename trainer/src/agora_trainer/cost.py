"""Admission-time gpu-seconds spend estimate (KFT §7, FT-E).

The manifest's static ``cost.est_units`` (§2) cannot gate a variable-size job whose data is
`fetch`ed lazily (KMI §7): a 200-sample QLoRA and a 2-million-sample full finetune share one
manifest. So the provider computes a **per-job** estimate at admission — **after** resolving
dataset cardinality (:mod:`agora_trainer.resolve`) — and checks *that* against the grant ceiling
(:mod:`agora_trainer.grant`), admitting a run only if the resolved estimate fits (FT-E).

The estimate is deterministic in the resolved sample cardinality, the epoch count, and the
``modality × method`` training cost, metered in the capability's ``gpu-seconds`` unit (§2). The
coefficients are a coarse, honest model — video ≫ image ≫ text, full-finetune ≫ SFT ≫ LoRA — not
a calibrated predictor; a live deployment refines them from its own run history. What matters for
the contract is that the gate runs on a *resolved* figure, before provisioning.
"""

from __future__ import annotations

from typing import Any

#: The capability's cost meter (KFT §2/§7).
METER = "gpu-seconds"

#: Per-sample-per-epoch gpu-seconds by modality — the coarse cost ladder (video ≫ image ≫ text).
_MODALITY_UNIT: dict[str, float] = {
    "text-generation": 0.5,
    "image-text-to-text": 1.5,
    "video-text-to-text": 4.0,
    "text-to-image": 2.0,
    "text-to-video": 8.0,
}

#: Training-method cost multiplier — full-finetune ≫ preference/SFT ≫ LoRA ≈ QLoRA.
_METHOD_MULT: dict[str, float] = {
    "qlora": 0.8,
    "lora": 1.0,
    "dpo": 2.0,
    "sft": 2.0,
    "full": 4.0,
}

#: Fallbacks for an unknown token (the compatibility gate has already run; this is defensive).
_DEFAULT_UNIT = 1.0
_DEFAULT_MULT = 1.0


def epochs_of(job: dict[str, Any]) -> int:
    """The job's epoch count (``hyperparams.epochs``), floored at 1 for a malformed value."""
    hyperparams = job.get("hyperparams", {}) or {}
    raw = hyperparams.get("epochs", 1)
    try:
        epochs = int(raw)
    except (TypeError, ValueError):
        return 1
    return epochs if epochs > 0 else 1


def estimate_gpu_seconds(*, modality: str, method: str, cardinality: int, epochs: int) -> float:
    """The per-job gpu-seconds estimate the grant ceiling gates against (KFT §7, FT-E)."""
    unit = _MODALITY_UNIT.get(modality, _DEFAULT_UNIT)
    mult = _METHOD_MULT.get(method, _DEFAULT_MULT)
    samples = max(cardinality, 0)
    return round(samples * max(epochs, 1) * unit * mult, 3)
