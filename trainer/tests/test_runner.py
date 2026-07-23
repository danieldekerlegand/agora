"""Run orchestration — admit, run the engine, stream §6 telemetry to a terminal event."""

from __future__ import annotations

import pytest

from agora_trainer.engine import StepRecord, UnsupportedJob
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

    def test_a_compatible_but_unwired_modality_is_unsupported_not_rejected(self) -> None:
        with pytest.raises(UnsupportedJob):
            run(
                valid_text_job(
                    modality="image-text-to-text",
                    method="qlora",
                    dataset={
                        "knowledge": ["kgp:pack:sha256-7b1e"],
                        "media": ["analyzer:asset:blake3-aa"],
                    },
                )
            )
