"""The `invoke:finetune` grant — the KFT §7 spend ceiling (KCB delta K).

`invoke` requires an ``invoke:finetune`` capability token (KCB §5), per-world and per-capability,
carrying a **``budget_units`` ceiling** in the capability's meter (``gpu-seconds``, §2/§7).
Because fine-tuning is the most expensive capability class on the bus, the ceiling is a **hard
admission gate**: a run whose admission-time estimate (:mod:`agora_trainer.cost`) exceeds
``budget_units`` is rejected **before** provisioning (FT-E), never partway through a run.

Issuing and signing the token is the calling workforce's governance (KCB §5/§6, US-6); here
the grant is the ceiling the admission gate reads. A grant with no ceiling (``budget_units``
``None``) is **ungated** — the offline default, so a run invoked without a supplied grant
still streams.
"""

from __future__ import annotations

from dataclasses import dataclass

from .cost import METER


@dataclass(frozen=True)
class Grant:
    """An ``invoke:finetune`` grant's spend ceiling (KFT §7). ``None`` ceiling = ungated."""

    #: The gpu-seconds ceiling; ``None`` admits any estimate (the offline default).
    budget_units: float | None = None
    #: The meter the ceiling is denominated in — the capability's ``gpu-seconds`` (§2/§7).
    meter: str = METER

    def admits(self, estimate: float) -> bool:
        """True when a run whose estimate is ``estimate`` gpu-seconds fits under the ceiling."""
        return self.budget_units is None or estimate <= self.budget_units


#: The offline default — an ungated grant, so a run invoked without a supplied grant still
#: streams. A module-level singleton (frozen, immutable) so it can be a safe default argument.
UNGATED = Grant()
