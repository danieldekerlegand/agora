"""The LLaMA-Factory engine adapter — text-generation + VLM (KFT §9).

The first rung of the §9 engine ladder. LLaMA-Factory is the general text-generation trainer and,
for the vision/video-language modalities (`image-text-to-text`, `video-text-to-text`), the general
**VLM** trainer; this adapter wraps it behind the :class:`~agora_trainer.engine.EngineAdapter`
interface so the runner drives it exactly as it drives the diffusers rung.

**Where the training actually runs.** On a GPU-equipped deployment :meth:`launch` shells out to
LLaMA-Factory with a config derived from the job's ``hyperparams`` and streams its per-step
trainer logs. This build ships no GPU and no LLaMA-Factory, so :meth:`launch` **replays a
recorded run** — a real run's per-step logs captured as a fixture — exactly as the
provider-router serves a keyless request from its offline placeholder rather than fabricating a
backend. The telemetry the runner emits is therefore real recorded training data, not a
synthesized loss curve (KFT §6). A live run is injected by constructing the adapter with a
``run_source``; the default replays the fixture.

**Multimodal data (FT-I).** For the VLM modalities the paired samples — which image/clip goes with
which text — are read from the **dataset-jsonl-header training records** (asset id + text per row),
not the ``dataset.media[]`` corpus array (KFT §4.1, FT-I); the media assets are `fetch`ed lazily
via the KMI ``fetch:asset`` seam (:mod:`agora_trainer.pairing`). Outputs — the finetuned-model
entity and its weight/export assets with §5.3 lineage and §5.4 egress/license inheritance — are
minted through the shared :mod:`agora_trainer.lineage` authority.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator, Mapping
from importlib import resources
from typing import Any

from . import lineage
from .engine import PreparedData, RunResult, StepRecord
from .modality import BY_NAME
from .pairing import AssetFetch, default_fetch, fetch_all, paired_samples
from .telemetry import TelemetryEvent

#: The engine name, surfaced in telemetry / provenance.
ENGINE_NAME = "llama-factory"

#: The modalities this rung serves, and the methods for each (KFT §3.1). ``text-generation`` is the
#: LLM path; the vision/video-language rows are the VLM path (US-4). ``full`` / ``dpo`` are
#: general-surface methods (advertised in the manifest) whose engine wiring is out of scope;
#: admission still accepts the *pair* (FT-F) but no rung here runs it — an honest, distinct outcome.
SERVES: dict[str, frozenset[str]] = {
    "text-generation": frozenset({"sft", "lora", "qlora"}),
    "image-text-to-text": frozenset({"lora", "qlora"}),
    "video-text-to-text": frozenset({"lora", "qlora"}),
}

#: The package holding the vendored fixtures, and the recorded run replayed when no live
#: LLaMA-Factory is present.
_FIXTURES_DIR = "fixtures"
_RUN_FIXTURE = "llama_factory_text_run.json"


def _load_fixture(name: str) -> dict[str, Any]:
    anchor = resources.files("agora_trainer").joinpath(_FIXTURES_DIR).joinpath(name)
    doc: dict[str, Any] = json.loads(anchor.read_text(encoding="utf-8"))
    return doc


def _records_of(doc: dict[str, Any]) -> tuple[StepRecord, ...]:
    records: list[StepRecord] = []
    for entry in doc.get("steps", ()):
        records.append(
            StepRecord(
                step=int(entry["step"]),
                ts=str(entry["ts"]),
                metrics={k: float(v) for k, v in entry.get("metrics", {}).items()},
                checkpoint=entry.get("checkpoint"),
                samples=tuple(entry.get("samples", ())),
            )
        )
    return tuple(records)


def recorded_text_run() -> list[StepRecord]:
    """The captured LLaMA-Factory run replayed by :meth:`LlamaFactoryAdapter.launch`."""
    return list(_records_of(_load_fixture(_RUN_FIXTURE)))


def _consumes_media(modality: str) -> bool:
    record = BY_NAME.get(modality)
    return record is not None and record.consumes_media


class LlamaFactoryAdapter:
    """LLaMA-Factory for ``text-generation`` + the VLM modalities (KFT §9)."""

    name = ENGINE_NAME

    def __init__(
        self,
        run_source: Iterable[StepRecord] | None = None,
        *,
        records_source: Iterable[Mapping[str, Any]] | None = None,
        fetch: AssetFetch = default_fetch,
    ) -> None:
        #: An injected live run (a real LLaMA-Factory launch); ``None`` replays the fixture.
        self._run_source = run_source
        #: Injected dataset-jsonl-header training records (the FT-I join); ``None`` → the fixture.
        self._records_source = records_source
        #: The KMI ``fetch:asset`` seam for lazy media pulls (KMI §7).
        self._fetch = fetch

    def supports(self, modality: str, method: str) -> bool:
        return method in SERVES.get(modality, frozenset())

    def prepare_data(self, job: dict[str, Any]) -> PreparedData:
        """Resolve the job's dataset refs (KFT §4.1) — knowledge for text; paired samples for VLM.

        For a VLM modality the paired ``(asset, text)`` samples are read from the training records
        (FT-I), NOT ``dataset.media[]`` (that array is the fetch/egress manifest), and each media
        asset is `fetch`ed lazily via ``fetch:asset`` (KMI §7).
        """
        dataset = job.get("dataset", {}) or {}
        knowledge = tuple(dataset.get("knowledge", ()))
        modality = str(job.get("modality", ""))
        if not _consumes_media(modality):
            return PreparedData(knowledge=knowledge, media=tuple(dataset.get("media", ())))
        records = self._records_source
        if records is None:
            records = self._load_records()
        samples = paired_samples(records)
        fetch_all(samples, self._fetch)  # lazy KMI fetch:asset per referenced asset (KMI §7)
        media = tuple(dict.fromkeys(s.asset for s in samples))
        return PreparedData(
            knowledge=knowledge, media=media, samples=samples, cardinality=len(samples)
        )

    @staticmethod
    def _load_records() -> tuple[Mapping[str, Any], ...]:
        """The offline VLM training records replayed when none are injected (FT-I)."""
        doc = _load_fixture(_RUN_FIXTURE)
        return tuple(doc.get("records", ()))

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
        a re-train (a new ``job`` id) mints a distinct one, never a silent collision. The full
        §5.3 lineage + §5.4 egress/license inheritance are built by the runner via
        :mod:`agora_trainer.lineage` (it holds the resolved ``{data ∪ base}`` facts).
        """
        step_list = list(records)
        model = lineage.mint_model_id(job)
        weights = tuple(
            lineage.mint_asset_id(model, artifact) for artifact in lineage.planned_artifacts(job)
        )
        ts = step_list[-1].ts if step_list else ""
        return RunResult(model=model, weights=weights, spent_units=None, ts=ts)
