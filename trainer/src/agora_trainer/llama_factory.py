"""The LLaMA-Factory engine adapter — text-generation SFT / LoRA / QLoRA (KFT §9).

The first rung of the §9 engine ladder. LLaMA-Factory is the general text-generation (and, in
US-4, VLM) trainer; this adapter wraps it behind the :class:`~agora_trainer.engine.EngineAdapter`
interface so the runner drives it exactly as it will drive Unsloth / Axolotl / diffusers.

**Where the training actually runs.** On a GPU-equipped deployment :meth:`launch` shells out to
LLaMA-Factory with a config derived from the job's ``hyperparams`` and streams its per-step
trainer logs. This build ships no GPU and no LLaMA-Factory, so :meth:`launch` **replays a
recorded run** — a real run's per-step logs captured as a fixture — exactly as the
provider-router serves a keyless request from its offline placeholder rather than fabricating a
backend. The telemetry the runner emits is therefore real recorded training data, not a
synthesized loss curve (KFT §6). A live run is injected by constructing the adapter with a
``run_source``; the default replays the fixture.

Outputs are **minted from the run's reproducibility anchor** (§5.2, FT-C): the finetuned-model
entity id and its weight/export asset ids are deterministic in the job activity id + ``seed`` +
``config_hash``, so re-reading the same run yields the same ids while a *different* run mints new
ones. The §5.3 lineage graph and the §5.4 egress/license inheritance those assets carry are
US-4's concern; here the terminal event simply announces the ids.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Iterator
from importlib import resources
from typing import Any

from .engine import PreparedData, RunResult, StepRecord
from .telemetry import TelemetryEvent

#: The engine name, surfaced in telemetry / provenance.
ENGINE_NAME = "llama-factory"

#: The modality this rung serves, and the methods it serves for it (KFT §3.1 text-generation
#: row, narrowed to what LLaMA-Factory drives here). ``full`` / ``dpo`` are general-surface
#: methods (advertised in the manifest) whose engine wiring is out of US-2's scope; admission
#: still accepts the *pair* (FT-F) but no US-2 rung runs it — an honest, distinct outcome.
SERVES_MODALITY = "text-generation"
SERVES_METHODS: frozenset[str] = frozenset({"sft", "lora", "qlora"})

#: The package holding the vendored fixtures, and the recorded run replayed when no live
#: LLaMA-Factory is present.
_FIXTURES_DIR = "fixtures"
_RUN_FIXTURE = "llama_factory_text_run.json"

#: The primary weight artifact every run produces — the LoRA adapter (§5.3, table row 1). Each
#: requested ``export`` becomes an additional asset alongside it.
PRIMARY_ARTIFACT = "safetensors-adapter"


def recorded_text_run() -> list[StepRecord]:
    """The captured LLaMA-Factory run replayed by :meth:`LlamaFactoryAdapter.launch`."""
    anchor = resources.files("agora_trainer").joinpath(_FIXTURES_DIR).joinpath(_RUN_FIXTURE)
    raw = anchor.read_text(encoding="utf-8")
    doc: dict[str, Any] = json.loads(raw)
    records: list[StepRecord] = []
    for entry in doc["steps"]:
        records.append(
            StepRecord(
                step=int(entry["step"]),
                ts=str(entry["ts"]),
                metrics={k: float(v) for k, v in entry.get("metrics", {}).items()},
                checkpoint=entry.get("checkpoint"),
                samples=tuple(entry.get("samples", ())),
            )
        )
    return records


class LlamaFactoryAdapter:
    """LLaMA-Factory for ``text-generation`` × {sft, lora, qlora} (KFT §9)."""

    name = ENGINE_NAME

    def __init__(self, run_source: Iterable[StepRecord] | None = None) -> None:
        #: An injected live run (a real LLaMA-Factory launch); ``None`` replays the fixture.
        self._run_source = run_source

    def supports(self, modality: str, method: str) -> bool:
        return modality == SERVES_MODALITY and method in SERVES_METHODS

    def prepare_data(self, job: dict[str, Any]) -> PreparedData:
        """Resolve the job's dataset refs (KFT §4.1) — knowledge for text; media stays lazy."""
        dataset = job.get("dataset", {})
        knowledge = tuple(dataset.get("knowledge", ()))
        media = tuple(dataset.get("media", ()))
        return PreparedData(knowledge=knowledge, media=media)

    def launch(self, job: dict[str, Any], prepared: PreparedData) -> Iterator[StepRecord]:
        """Yield the run's step records in monotonic order.

        A live deployment shells out to LLaMA-Factory here using ``prepared`` + the job's
        ``hyperparams``; absent one, the recorded run is replayed. Either way the records are
        real per-step trainer logs, never a fabricated curve.
        """
        source = self._run_source if self._run_source is not None else recorded_text_run()
        yield from source

    def emit_telemetry(self, job: dict[str, Any], record: StepRecord) -> TelemetryEvent:
        """One §6 event for one step — content-addressed by job+step (idempotent)."""
        return TelemetryEvent(
            job=str(job["job"]),
            step=record.step,
            ts=record.ts,
            metrics=record.metrics,
            checkpoint=record.checkpoint,
            samples=record.samples,
        )

    def export(
        self, job: dict[str, Any], prepared: PreparedData, records: Iterable[StepRecord]
    ) -> RunResult:
        """Mint the finetuned-model entity (§5.1) + its weight/export assets (§5.3).

        The ids are deterministic in the run's reproducibility anchor (§5.2, FT-C) — the job
        activity id, ``seed``, and ``config_hash`` — so the same run mints the same model while
        a re-train (a new ``job`` id) mints a distinct one, never a silent collision.
        """
        step_list = list(records)
        model = self._mint_model_id(job)
        artifacts = self._artifacts(job)
        weights = tuple(self._mint_asset_id(model, artifact) for artifact in artifacts)
        ts = step_list[-1].ts if step_list else ""
        return RunResult(model=model, weights=weights, spent_units=None, ts=ts)

    # --- minting -----------------------------------------------------------------

    @staticmethod
    def _anchor(job: dict[str, Any]) -> str:
        """The reproducibility anchor string (§5.2) the outputs are minted from."""
        return "\x00".join(
            (
                str(job.get("job", "")),
                str(job.get("seed", "")),
                str(job.get("config_hash", "")),
                str(job.get("base_model", "")),
                str(job.get("modality", "")),
                str(job.get("method", "")),
            )
        )

    def _mint_model_id(self, job: dict[str, Any]) -> str:
        digest = hashlib.sha256(self._anchor(job).encode()).hexdigest()[:16]
        return f"agora:model:ft-{digest}"

    @staticmethod
    def _artifacts(job: dict[str, Any]) -> tuple[str, ...]:
        """The primary adapter plus each requested export, de-duplicated, order-stable (§5.3)."""
        artifacts = [PRIMARY_ARTIFACT]
        for export in job.get("export", ()):
            token = str(export)
            if token not in artifacts:
                artifacts.append(token)
        return tuple(artifacts)

    @staticmethod
    def _mint_asset_id(model: str, artifact: str) -> str:
        digest = hashlib.sha256(f"{model}\x00{artifact}".encode()).hexdigest()
        return f"sha256:{digest}"
