"""Run orchestration — admit, run the engine, stream §6 telemetry to a terminal event."""

from __future__ import annotations

import pytest

from agora_trainer.engine import StepRecord
from agora_trainer.grant import Grant
from agora_trainer.llama_factory import LlamaFactoryAdapter
from agora_trainer.runner import RunRejected, run
from agora_trainer.telemetry import TelemetryEvent
from conftest import valid_text_job


def _events(**overrides: object) -> list[TelemetryEvent]:
    return list(run(valid_text_job(**overrides)))


class TestHappyPath:
    def test_it_streams_monotonic_steps_then_one_terminal_event(self) -> None:
        events = _events()
        progress = [e for e in events if not e.terminal]
        terminals = [e for e in events if e.terminal]
        assert len(terminals) == 1
        assert events[-1].terminal  # the terminal event closes the stream
        steps = [e.step for e in events]
        assert steps == sorted(steps) and len(set(steps)) == len(steps)  # monotonic + unique
        assert all(e.metrics.get("train_loss") is not None for e in progress)

    def test_the_terminal_event_carries_the_model_and_weight_asset_ids(self) -> None:
        terminal = _events()[-1]
        assert terminal.model is not None
        assert terminal.model.startswith("agora:model:ft-")
        # one asset per artifact: the primary safetensors adapter + each *distinct* requested
        # export. export=[gguf:Q4_K_M, safetensors-adapter] dedups to {adapter, gguf} → 2.
        assert len(terminal.weights) == 2
        assert all(w.startswith("sha256:") for w in terminal.weights)

    def test_the_model_id_is_deterministic_in_the_run_anchor(self) -> None:
        """Same job (§5.2 anchor) mints the same model; a re-train (new job id) mints a new one."""
        assert _events()[-1].model == _events()[-1].model
        other = list(run(valid_text_job(job="orchestrator:activity:ft-run/retrain")))
        assert other[-1].model != _events()[-1].model


class TestMultimodalRun:
    def _t2i_job(self, **overrides: object) -> dict[str, object]:
        job: dict[str, object] = valid_text_job(
            modality="text-to-image",
            method="lora",
            dataset={"media": ["analyzer:asset:blake3-corpus"]},
            export=["safetensors-adapter", "onnx"],
        )
        job.update(overrides)
        return job

    def test_a_text_to_image_job_runs_through_the_diffusers_rung(self) -> None:
        """The media-plane modalities are wired (US-4): they stream telemetry to a terminal."""
        events = list(run(self._t2i_job()))
        assert events[-1].terminal
        assert events[-1].model is not None and events[-1].model.startswith("agora:model:ft-")
        assert events[-1].weights

    def test_the_terminal_event_carries_the_full_lineage_bundle(self) -> None:
        """The §5 artifact bundle rides the terminal event — model entity + PROV + weight assets."""
        bundle = list(run(self._t2i_job()))[-1].artifacts
        assert bundle is not None
        # §5.1 the model links to its base; §5.2 the run activity generated the model + weights.
        assert bundle.model.based_on == "pinakes:model:qwen2.5-3b-instruct"
        assert bundle.model.derived_from == "pinakes:model:qwen2.5-3b-instruct"
        assert bundle.model.id in bundle.activity.generated
        assert set(bundle.weight_ids) <= set(bundle.activity.generated)
        # §5.3 the primary weights derive_from the base; each export is a variant_of the primary.
        assert bundle.weights[0].lineage[0].relation == "media:derived_from"
        assert all(w.lineage for w in bundle.weights)


class TestIdempotency:
    def test_redelivered_events_are_content_addressed_and_converge(self) -> None:
        """The same run re-emitted yields identical event ids per (job, step) (KFT §6)."""
        first = {e.step: e.id for e in _events()}
        second = {e.step: e.id for e in _events()}
        assert first == second


class TestInjectedRun:
    def test_a_live_run_source_flows_through_the_stream(self) -> None:
        """The interface takes a real launch just as it takes the recorded fixture (KFT §6/§9)."""
        recorded = [
            StepRecord(step=1, ts="t1", metrics={"train_loss": 2.0}),
            StepRecord(step=2, ts="t2", metrics={"train_loss": 1.0}, checkpoint="agora:asset:ck"),
        ]
        ladder = (LlamaFactoryAdapter(run_source=recorded),)
        events = list(run(valid_text_job(), ladder=ladder))
        assert [e.step for e in events if not e.terminal] == [1, 2]
        assert events[-1].terminal and events[-1].step == 3  # one past the last training step


class TestAdmissionGuards:
    def test_a_rejected_job_never_reaches_the_engine(self) -> None:
        job = valid_text_job()
        del job["base_model"]
        with pytest.raises(RunRejected) as caught:
            run(job)
        assert not caught.value.report.ok

    def test_a_local_only_cloud_placement_is_rejected_before_the_engine(self) -> None:
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "local-only"})
        with pytest.raises(RunRejected) as caught:
            run(job)
        assert any(p.code == "egress-cross-boundary" for p in caught.value.report.problems)

    def test_an_over_ceiling_run_is_rejected_before_the_engine(self) -> None:
        with pytest.raises(RunRejected) as caught:
            run(valid_text_job(), grant=Grant(budget_units=1))
        assert any(p.code == "budget" for p in caught.value.report.problems)
