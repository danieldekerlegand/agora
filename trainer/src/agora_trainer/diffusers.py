"""The diffusers + ai-toolkit / SimpleTuner engine adapter — text-to-image / -video (KFT §9).

The second rung of the §9 engine ladder. diffusers (with ai-toolkit / SimpleTuner) is the general
image/video-diffusion trainer; this adapter wraps it behind the
:class:`~agora_trainer.engine.EngineAdapter` interface so the runner drives it identically to the
LLaMA-Factory rung. It serves `text-to-image` ({lora, full}) and `text-to-video` ({lora}) — the
KFT §3.1 media-plane modalities.

**Multimodal data (FT-I).** The paired samples — which image/clip trains against which caption —
are read from the **dataset-jsonl-header training records** (asset id + text per row), NOT the
``dataset.media[]`` corpus array (that array is the fetch/egress manifest, the records are the
join — KFT §4.1, FT-I). Each media asset is `fetch`ed lazily via the KMI ``fetch:asset`` seam
(:mod:`agora_trainer.pairing`, KMI §7); nothing is inlined into the job.

**Where the training actually runs.** As with the LLaMA-Factory rung, a GPU-equipped deployment
shells out to diffusers here; this build ships no GPU, so :meth:`launch` replays a recorded run —
real per-step logs with FT-L preview-grid asset ids — rather than fabricating a curve. Outputs are
minted through the shared :mod:`agora_trainer.lineage` authority (§5.1/§5.3), so the model + weight
ids and their lineage match every other engine's.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator, Mapping
from importlib import resources
from typing import Any

from . import lineage
from .engine import PreparedData, RunResult, StepRecord
from .pairing import AssetFetch, default_fetch, fetch_all, paired_samples
from .telemetry import TelemetryEvent

#: The engine name, surfaced in telemetry / provenance.
ENGINE_NAME = "diffusers"

#: The media-plane modalities this rung serves, and the methods for each (KFT §3.1).
SERVES: dict[str, frozenset[str]] = {
    "text-to-image": frozenset({"lora", "full"}),
    "text-to-video": frozenset({"lora"}),
}

_FIXTURES_DIR = "fixtures"
_RUN_FIXTURE = "diffusers_image_run.json"


def _load_fixture() -> dict[str, Any]:
    anchor = resources.files("agora_trainer").joinpath(_FIXTURES_DIR).joinpath(_RUN_FIXTURE)
    doc: dict[str, Any] = json.loads(anchor.read_text(encoding="utf-8"))
    return doc


def recorded_image_run() -> list[StepRecord]:
    """The captured diffusers run replayed by :meth:`DiffusersAdapter.launch` (FT-L previews)."""
    records: list[StepRecord] = []
    for entry in _load_fixture().get("steps", ()):
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


class DiffusersAdapter:
    """diffusers + ai-toolkit / SimpleTuner for the media-plane modalities (KFT §9)."""

    name = ENGINE_NAME

    def __init__(
        self,
        run_source: Iterable[StepRecord] | None = None,
        *,
        records_source: Iterable[Mapping[str, Any]] | None = None,
        fetch: AssetFetch = default_fetch,
    ) -> None:
        #: An injected live run (a real diffusers launch); ``None`` replays the fixture.
        self._run_source = run_source
        #: Injected dataset-jsonl-header training records (the FT-I join); ``None`` → the fixture.
        self._records_source = records_source
        #: The KMI ``fetch:asset`` seam for lazy media pulls (KMI §7).
        self._fetch = fetch

    def supports(self, modality: str, method: str) -> bool:
        return method in SERVES.get(modality, frozenset())

    def prepare_data(self, job: dict[str, Any]) -> PreparedData:
        """Read the paired ``(asset, text)`` samples from the training records (FT-I).

        The samples come from the dataset-jsonl-header training records, never ``dataset.media[]``
        (KFT §4.1, FT-I); each referenced asset is `fetch`ed lazily via ``fetch:asset`` (KMI §7).
        """
        records = self._records_source
        if records is None:
            records = tuple(_load_fixture().get("records", ()))
        samples = paired_samples(records)
        fetch_all(samples, self._fetch)  # lazy KMI fetch:asset per referenced asset (KMI §7)
        media = tuple(dict.fromkeys(s.asset for s in samples))
        return PreparedData(media=media, samples=samples, cardinality=len(samples))

    def launch(self, job: dict[str, Any], prepared: PreparedData) -> Iterator[StepRecord]:
        """Yield the run's step records — real recorded diffusion logs, never a fabricated curve."""
        source = self._run_source if self._run_source is not None else recorded_image_run()
        yield from source

    def emit_telemetry(self, job: dict[str, Any], record: StepRecord) -> TelemetryEvent:
        """One §6 event for one step — content-addressed by job+step, carrying FT-L previews."""
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

        Ids are minted from the §5.2 run anchor through the shared :mod:`agora_trainer.lineage`
        authority; the full §5.3 lineage + §5.4 inheritance is built by the runner.
        """
        step_list = list(records)
        model = lineage.mint_model_id(job)
        weights = tuple(
            lineage.mint_asset_id(model, artifact) for artifact in lineage.planned_artifacts(job)
        )
        ts = step_list[-1].ts if step_list else ""
        return RunResult(model=model, weights=weights, spent_units=None, ts=ts)
