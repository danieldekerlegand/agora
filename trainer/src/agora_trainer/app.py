"""The trainer's HTTP surface — liveness, the A2A agent card, and the KCB manifest.

Deliberately small in US-1: the trainer *publishes itself* so the registry can crawl it and
peers can discover it, but the `finetune` invoke / subscribe task surface (job admission,
telemetry) lands in US-2 / US-6. Every route here corresponds to an endpoint the manifest
advertises, and no manifest endpoint is unserved (ADR-0001 decision 3).

The config is built once from the process environment and cached; tests build their own
:class:`TrainerConfig` and override :func:`get_config`, so no test mutates global state.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, FastAPI

from . import KCB_VERSION, KFT_VERSION, __version__
from .config import TrainerConfig
from .manifest import AGENT_CARD_PATH, MANIFEST_PATH, agent_card, capability_manifest

app = FastAPI(title="agora trainer", version=__version__)


@lru_cache(maxsize=1)
def get_config() -> TrainerConfig:
    """The process-wide config. Cached: it is an environment snapshot."""
    return TrainerConfig.from_env()


ConfigDep = Annotated[TrainerConfig, Depends(get_config)]


@app.get("/health")
def health(config: ConfigDep) -> dict[str, str]:
    """Liveness + identity. Holds no secrets to leak."""
    return {
        "status": "ok",
        "identity": config.identity,
        "version": __version__,
        "kcb_version": KCB_VERSION,
        "kft_version": KFT_VERSION,
    }


@app.get(AGENT_CARD_PATH)
def a2a_agent_card(config: ConfigDep) -> dict[str, Any]:
    """The A2A agent card — the dialable address, pointing at the KCB manifest (KCB §3)."""
    return agent_card(config)


@app.get(MANIFEST_PATH)
def kcb_manifest(config: ConfigDep) -> dict[str, Any]:
    """The trainer's KCB capability manifest (KCB §2, KFT §2) — what the registry indexes."""
    return capability_manifest(config)
