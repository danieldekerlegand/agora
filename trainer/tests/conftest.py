"""Shared fixtures: build a config from an explicit environment, never the process's.

Every test states its whole configuration inline, so a developer's real environment cannot
silently change what the manifest advertises.
"""

from __future__ import annotations

from agora_trainer.config import TrainerConfig


def config_for(**env: str) -> TrainerConfig:
    """A config from exactly these variables — no process env."""
    return TrainerConfig.from_env(env)
