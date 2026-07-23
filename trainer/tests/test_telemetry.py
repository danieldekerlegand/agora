"""The KFT §6 training-telemetry event — idempotency key + wire shape."""

from __future__ import annotations

from agora_trainer.telemetry import TelemetryEvent, event_id


class TestIdempotencyKey:
    def test_the_key_is_content_addressed_by_job_and_step(self) -> None:
        """Redelivery of the same (job, step) hashes to the same id — no exactly-once needed."""
        assert event_id("j", 3) == event_id("j", 3)

    def test_distinct_steps_and_jobs_get_distinct_ids(self) -> None:
        assert event_id("j", 3) != event_id("j", 4)
        assert event_id("j", 3) != event_id("k", 3)

    def test_the_event_id_matches_the_free_function(self) -> None:
        event = TelemetryEvent(job="j", step=7, ts="t")
        assert event.id == event_id("j", 7)


class TestWireShape:
    def test_a_progress_event_omits_empty_optionals(self) -> None:
        body = TelemetryEvent(job="j", step=1, ts="t", metrics={"train_loss": 0.5}).describe()
        assert body == {
            "id": event_id("j", 1),
            "job": "j",
            "step": 1,
            "metrics": {"train_loss": 0.5},
            "ts": "t",
        }
        assert "checkpoint" not in body and "terminal" not in body

    def test_optional_checkpoint_and_samples_ride_when_present(self) -> None:
        body = TelemetryEvent(
            job="j", step=1, ts="t", checkpoint="agora:asset:blake3-ck", samples=("s1",)
        ).describe()
        assert body["checkpoint"] == "agora:asset:blake3-ck"
        assert body["samples"] == ["s1"]

    def test_the_terminal_event_announces_model_and_weights(self) -> None:
        body = TelemetryEvent(
            job="j",
            step=61,
            ts="t",
            terminal=True,
            model="agora:model:ft-abc",
            weights=("sha256:aa", "sha256:bb"),
            spent_units=1732004.0,
        ).describe()
        assert body["terminal"] is True
        assert body["model"] == "agora:model:ft-abc"
        assert body["weights"] == ["sha256:aa", "sha256:bb"]
        assert body["spent_units"] == 1732004.0
