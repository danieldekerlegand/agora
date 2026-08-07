"""Shared fixtures: a config from an explicit environment, and canonical finetune jobs.

Every test states its whole configuration inline, so a developer's real environment cannot
silently change what the manifest advertises. The job builders return fresh dicts so a test
that mutates one cannot leak into another.
"""

from __future__ import annotations

from typing import Any

from agora_trainer.config import TrainerConfig


def config_for(**env: str) -> TrainerConfig:
    """A config from exactly these variables — no process env."""
    return TrainerConfig.from_env(env)


def _header() -> dict[str, Any]:
    """A valid dataset-jsonl-header (koine schema) — carries tier + license + provenance."""
    return {
        "record": "header",
        "contractVersion": "0.4.0",
        "datasetKind": "rules-sft",
        "source": "insimul",
        "tier": "synthetic",
        "license": "CC-BY-4.0",
        "generatedAt": "2026-07-23T00:00:00Z",
        "provenance": {"world": "insimul:world:alderforest"},
    }


def valid_text_job(**overrides: Any) -> dict[str, Any]:
    """A schema-valid, FT-F-compatible text-generation QLoRA job (KFT §3) the US-2 engine runs."""
    job: dict[str, Any] = {
        "kft_version": "0.3.0",
        "job": "orchestrator:activity:ft-run/9f2a",
        "base_model": "pinakes:model:qwen2.5-3b-instruct",
        "modality": "text-generation",
        "method": "qlora",
        "dataset": {
            "knowledge": ["kgp:pack:sha256-7b1e0f3c9a2d"],
            "header": _header(),
        },
        "hyperparams": {"epochs": 3, "lr": 0.0002, "max_seq_len": 2048},
        "export": ["gguf:Q4_K_M", "safetensors-adapter"],
        "compute": {"class": "local-mps", "egress": "derived"},
        "seed": 42,
        "config_hash": "sha256-cfg9f2a",
    }
    job.update(overrides)
    return job


def exhaust_header(**overrides: Any) -> dict[str, Any]:
    """A KFT 0.4.0 ``dataset-jsonl-header`` for a producing application's exhaust.

    Carries the two axes 0.4.0 added: the explicit ``egress`` class the §4.2 gate reads (FT-N)
    and the ``recordCount`` the §7 estimate is sized from (FT-P).
    """
    header: dict[str, Any] = {
        "record": "header",
        "contractVersion": "0.4.0",
        "datasetKind": "nl-edit",
        "source": "mediastore",
        "tier": "personal",
        "license": "PERSONAL",
        "egress": "local-only",
        "recordCount": 300,
        "generatedAt": "2026-08-06T00:00:00Z",
        "provenance": {"runs": 300},
    }
    header.update(overrides)
    return header


def exhaust_job(**overrides: Any) -> dict[str, Any]:
    """A producer's training exhaust as a by-reference KFT dataset (§4.1, FT-M).

    The koine scenario's shape: an application's recorded runs, serialized as a training-record
    JSONL, minted as a KMI asset, and referenced — never inlined — with its header copied into
    the manifest so the gate runs before a byte moves.
    """
    job: dict[str, Any] = {
        "kft_version": "0.4.0",
        "job": "orchestrator:activity:ft-run/e9d7",
        "base_model": "refkb:model:qwen2.5-3b-instruct",
        "modality": "text-generation",
        "method": "qlora",
        "dataset": {
            "records": ["mediastore:asset:blake3-e9d7a1"],
            "header": [exhaust_header()],
        },
        "hyperparams": {"epochs": 1, "lr": 0.0002, "max_seq_len": 2048},
        "export": ["safetensors-adapter"],
        "compute": {"class": "local-mps", "egress": "derived"},
        "seed": 42,
        "config_hash": "sha256-cfge9d7",
    }
    job.update(overrides)
    return job
