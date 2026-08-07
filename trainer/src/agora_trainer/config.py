"""The trainer's configuration — one typed schema, read from the environment.

Deliberately small: the trainer needs to know *where it lives* (the public base URL that its
KCB manifest advertises so peers dial it directly, ADR-0001 decision 3) and *who it is* (its
KINP identity). The engine ladder and compute-backend settings arrive with the adapters
(US-2 / US-3); this stays a thin, secret-free record so a config can be logged safely.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict

from . import TRAINER_IDENTITY

#: The trainer's own public address, for the endpoints its manifest publishes. A separate
#: service from the provider-router, so a separate default port.
BASE_URL_ENV = "AGORA_TRAINER_PUBLIC_BASE_URL"
DEFAULT_BASE_URL = "http://127.0.0.1:8001"

#: Where the KCB discovery registry lives, so the dataset bridge can ask it which `finetune`
#: provider gets a job (KFT §8/FT-K, :func:`agora_trainer.bridge.registry_directory`). Unset —
#: the default — means no registry is indexed and this trainer is the only candidate.
REGISTRY_URL_ENV = "AGORA_TRAINER_REGISTRY_URL"


class TrainerConfig(BaseModel):
    """Everything the trainer's HTTP surface and manifest need, parsed once from the env."""

    model_config = ConfigDict(frozen=True)

    #: The public base URL peers reach this trainer at (no trailing slash).
    base_url: str = DEFAULT_BASE_URL
    #: The trainer's KINP identity — published in the manifest and reported by ``/health``.
    identity: str = TRAINER_IDENTITY
    #: The KCB discovery registry the dataset bridge asks for provider selection (KFT §8). Empty
    #: means none is configured — the bridge then has this trainer as its only candidate.
    registry_url: str = ""

    def describe(self) -> dict[str, object]:
        """A reportable, secret-free view (the trainer holds no secrets at this stage)."""
        return {
            "identity": self.identity,
            "base_url": self.base_url,
            "registry_url": self.registry_url,
        }

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> TrainerConfig:
        """Parse ``env`` (default ``os.environ``); an unset base URL keeps the default."""
        source = os.environ if env is None else env
        base_url = (source.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")
        identity = (source.get("AGORA_TRAINER_IDENTITY") or TRAINER_IDENTITY).strip()
        registry_url = (source.get(REGISTRY_URL_ENV) or "").rstrip("/")
        return cls(
            base_url=base_url,
            identity=identity or TRAINER_IDENTITY,
            registry_url=registry_url,
        )
