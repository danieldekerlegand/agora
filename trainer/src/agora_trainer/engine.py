"""The engine-adapter interface — the KFT §9 engine ladder, one rung at a time.

KFT fixes only the `finetune` contract; *which* engine runs a job (LLaMA-Factory, Unsloth,
Axolotl, diffusers) is **producer-internal** (§9), selected from the job's ``modality`` +
``method``. This module is the seam every engine plugs into, so the run orchestration
(:mod:`agora_trainer.runner`) is written once against the interface and never against a
specific engine.

The lifecycle an adapter implements is a fixed four-step sequence:

    prepare_data → launch → emit_telemetry → export

* :meth:`EngineAdapter.prepare_data` resolves the job's referenced dataset (KFT §4.1) into a
  :class:`PreparedData` the engine can consume — for text that is the KGP knowledge refs; media
  is `fetch`ed lazily in US-4.
* :meth:`EngineAdapter.launch` runs the training and yields raw :class:`StepRecord`s.
* :meth:`EngineAdapter.emit_telemetry` maps one :class:`StepRecord` onto a §6
  :class:`~agora_trainer.telemetry.TelemetryEvent`.
* :meth:`EngineAdapter.export` mints the run's outputs — the finetuned-model entity id (§5.1)
  and its weight/export asset ids (§5.3) — as a :class:`RunResult` for the terminal event.

Adapter *selection* is by ``modality`` + ``method`` (§9): :func:`select_adapter` walks the
registered ladder and returns the first rung that serves the pair, or raises
:class:`UnsupportedJob`. US-2 registers the LLaMA-Factory rung (text-generation); US-4 appends
the diffusers rung (text-to-image / -video) to the same ladder.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .pairing import PairedSample
from .telemetry import TelemetryEvent


@dataclass(frozen=True)
class PreparedData:
    """The resolved training inputs for a run (KFT §4.1) — data by reference, never inlined."""

    #: The KGP GroundingPack ids (text/knowledge data) this run trains on.
    knowledge: tuple[str, ...] = ()
    #: The KMI asset ids (multimodal data), `fetch`ed lazily by the engine (KMI §7).
    media: tuple[str, ...] = ()
    #: Resolved sample cardinality once known — the load-bearing input to the §7 estimate (US-3).
    cardinality: int | None = None
    #: The paired multimodal training samples (asset id + text per row) read from the
    #: dataset-jsonl-header training records — the FT-I join, NOT the corpus arrays (KFT §4.1).
    samples: tuple[PairedSample, ...] = ()


@dataclass(frozen=True)
class StepRecord:
    """One raw training step as the engine reports it — pre-telemetry, engine-native."""

    step: int
    ts: str
    metrics: dict[str, float] = field(default_factory=dict)
    checkpoint: str | None = None
    samples: tuple[str, ...] = ()


@dataclass(frozen=True)
class RunResult:
    """The outputs of a completed run — what the terminal §6 event announces."""

    #: The generated finetuned-model KINP entity id — minted, not content-addressed (§5.2, FT-C).
    model: str
    #: The generated weight/export KMI asset ids (§5.3).
    weights: tuple[str, ...]
    #: gpu-seconds spent (§7); ``None`` until the §7 metering of US-3 lands.
    spent_units: float | None = None
    #: The timestamp of the terminal event (carried from the last step; no wall-clock needed).
    ts: str = ""


class UnsupportedJob(Exception):
    """No registered engine serves this ``modality`` × ``method`` (KFT §9)."""


@runtime_checkable
class EngineAdapter(Protocol):
    """One rung of the §9 engine ladder. Stateless w.r.t. a run — a job is passed through."""

    #: The engine's stable name, surfaced in telemetry/provenance (e.g. ``"llama-factory"``).
    name: str

    def supports(self, modality: str, method: str) -> bool:
        """True when this engine serves the ``modality`` × ``method`` pair (§9)."""
        ...

    def prepare_data(self, job: dict[str, Any]) -> PreparedData:
        """Resolve the job's referenced dataset (KFT §4.1) into engine-ready inputs."""
        ...

    def launch(self, job: dict[str, Any], prepared: PreparedData) -> Iterator[StepRecord]:
        """Run the training, yielding raw step records in monotonic ``step`` order."""
        ...

    def emit_telemetry(self, job: dict[str, Any], record: StepRecord) -> TelemetryEvent:
        """Map one raw step onto a §6 telemetry event (content-addressed by job+step)."""
        ...

    def export(
        self, job: dict[str, Any], prepared: PreparedData, records: Iterable[StepRecord]
    ) -> RunResult:
        """Mint the run outputs — finetuned-model id (§5.1) + weight/export assets (§5.3)."""
        ...


def select_adapter(modality: str, method: str, ladder: Iterable[EngineAdapter]) -> EngineAdapter:
    """The first engine on ``ladder`` that serves ``modality`` × ``method`` (KFT §9).

    Raises :class:`UnsupportedJob` when no rung serves the pair — the caller has already run
    the FT-F compatibility gate (:mod:`agora_trainer.validate`), so reaching here with no rung
    means a *compatible* modality whose engine is not yet wired (e.g. a diffusers modality
    before US-4), which is a distinct, honest failure from an incompatible pair.
    """
    for adapter in ladder:
        if adapter.supports(modality, method):
            return adapter
    raise UnsupportedJob(
        f"no engine adapter serves modality {modality!r} with method {method!r} (KFT §9)"
    )
