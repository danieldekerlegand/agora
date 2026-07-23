"""Run orchestration — admit a job, walk the §9 engine, stream §6 telemetry.

This is the one place the four-step adapter lifecycle (prepare_data → launch → emit_telemetry →
export) is sequenced, written against the :mod:`~agora_trainer.engine` interface so it is
engine-agnostic. It composes the pieces US-2 builds:

1. **Admit** — :func:`~agora_trainer.validate.validate_job` (schema + modality×method, FT-F).
   A rejected job raises :class:`RunRejected` carrying the structured report, *before* any
   engine is selected or any compute is committed (KFT §3.1).
2. **Select** — :func:`~agora_trainer.engine.select_adapter` picks the engine from
   ``modality`` + ``method`` (§9); a compatible-but-unwired pair raises
   :class:`~agora_trainer.engine.UnsupportedJob`.
3. **Stream** — the returned generator yields one §6 telemetry event per training step, in
   monotonic ``step`` order, then exactly one terminal event announcing the finetuned-model id
   (§5.1) and its weight/export asset ids (§5.3).

Admission and selection run **eagerly** (the returned value is already past them), so a caller
learns a rejection at call time — not part-way through streaming a response.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import Any

from .engine import EngineAdapter, select_adapter
from .llama_factory import LlamaFactoryAdapter
from .telemetry import TelemetryEvent
from .validate import Report, validate_job

#: The §9 engine ladder in preference order. US-2 wires the LLaMA-Factory rung; US-4 appends the
#: diffusers rung for the text-to-image / -video modalities.
LADDER: tuple[EngineAdapter, ...] = (LlamaFactoryAdapter(),)


class RunRejected(Exception):
    """A job failed admission (KFT §3.1) — carries the structured :class:`Report`."""

    def __init__(self, report: Report) -> None:
        self.report = report
        super().__init__(f"job rejected at admission ({report.status.name.lower()})")


def _terminal(job: dict[str, Any], last_step: int, result: Any) -> TelemetryEvent:
    """The single completion event that closes the stream (KFT §6)."""
    return TelemetryEvent(
        job=str(job["job"]),
        step=last_step + 1,  # one past the last training step — monotonic, distinct event id
        ts=result.ts,
        metrics={},
        terminal=True,
        model=result.model,
        weights=result.weights,
        spent_units=result.spent_units,
    )


def run(
    job: dict[str, Any], *, ladder: Iterable[EngineAdapter] = LADDER
) -> Iterator[TelemetryEvent]:
    """Admit + run ``job``, returning the §6 telemetry stream as a generator.

    Raises :class:`RunRejected` (admission) or
    :class:`~agora_trainer.engine.UnsupportedJob` (no engine) eagerly; iterating the result
    only streams events.
    """
    report = validate_job(job)
    if not report.ok:
        raise RunRejected(report)
    adapter = select_adapter(str(job["modality"]), str(job["method"]), ladder)
    prepared = adapter.prepare_data(job)

    def _events() -> Iterator[TelemetryEvent]:
        # Step records are tiny (a step index + a few floats), never the weights — buffering
        # them so `export` sees the same run the stream emitted is cheap and keeps `launch` a
        # single-use generator (a live LLaMA-Factory launch cannot be replayed).
        records = []
        last_step = -1
        for record in adapter.launch(job, prepared):
            last_step = record.step
            records.append(record)
            yield adapter.emit_telemetry(job, record)
        result = adapter.export(job, prepared, records)
        yield _terminal(job, last_step, result)

    return _events()
