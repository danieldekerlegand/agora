"""The KFT §6 training-telemetry stream — the real replacement for a fabricated loss curve.

A run `invoke`d over the bus streams these events to any consumer that `subscribe`s (KCB §4).
Two properties are contractual (KFT §6):

* **Idempotent under redelivery.** Each event is content-addressed by ``job`` + ``step`` (its
  :attr:`TelemetryEvent.event_id`), so a redelivered step carries the *same* id and a consumer
  deduplicates without an exactly-once transport. Progress events are monotonic in ``step``;
  the run ends with exactly one :attr:`terminal` event.
* **The terminal event carries the outputs.** It names the generated finetuned-model entity id
  (KINP, §5.1) and its weight/export asset ids (KMI, §5.3), plus ``spent_units`` (§7) — so a
  subscriber that saw only the last event still learns what the run produced.

A ``checkpoint`` ref MAY arrive before its bytes propagate (KCB delta L); the shape carries the
reference and the consumer `fetch`es lazily. ``samples`` are optional FT-L preview asset ids.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any


def event_id(job: str, step: int) -> str:
    """The content-addressed idempotency key for a ``(job, step)`` (KFT §6).

    Deterministic and collision-free across steps within a job: a redelivered step hashes to
    the same id, which is what lets the stream skip an exactly-once guarantee.
    """
    digest = hashlib.sha256(f"{job}\x00{step}".encode()).hexdigest()
    return f"ft-event:sha256-{digest}"


@dataclass(frozen=True)
class TelemetryEvent:
    """One event on the §6 stream — a training step, or the terminal completion event."""

    job: str
    step: int
    ts: str
    metrics: dict[str, float] = field(default_factory=dict)
    #: Optional KMI checkpoint asset id — resumable state; its bytes may lag the ref (delta L).
    checkpoint: str | None = None
    #: Optional FT-L preview asset ids (loss grids, image/clip previews).
    samples: tuple[str, ...] = ()
    #: True on the single completion event that closes the stream.
    terminal: bool = False
    #: On the terminal event: the generated finetuned-model KINP entity id (§5.1).
    model: str | None = None
    #: On the terminal event: the generated weight/export KMI asset ids (§5.3).
    weights: tuple[str, ...] = ()
    #: On the terminal event: gpu-seconds actually spent (§7).
    spent_units: float | None = None

    @property
    def id(self) -> str:
        """The idempotency key — same ``(job, step)`` always yields this same id."""
        return event_id(self.job, self.step)

    def describe(self) -> dict[str, Any]:
        """The §6 wire shape; optional fields are omitted when empty rather than sent null."""
        body: dict[str, Any] = {
            "id": self.id,
            "job": self.job,
            "step": self.step,
            "metrics": dict(self.metrics),
            "ts": self.ts,
        }
        if self.checkpoint is not None:
            body["checkpoint"] = self.checkpoint
        if self.samples:
            body["samples"] = list(self.samples)
        if self.terminal:
            body["terminal"] = True
            if self.model is not None:
                body["model"] = self.model
            if self.weights:
                body["weights"] = list(self.weights)
            if self.spent_units is not None:
                body["spent_units"] = self.spent_units
        return body
