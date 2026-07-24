"""The admission-time gpu-seconds estimate (KFT §7, FT-E) — resolved-cardinality-driven."""

from __future__ import annotations

from agora_trainer.cost import epochs_of, estimate_gpu_seconds


class TestEstimate:
    def test_it_scales_with_cardinality_and_epochs(self) -> None:
        one = estimate_gpu_seconds(
            modality="text-generation", method="lora", cardinality=1000, epochs=1
        )
        more = estimate_gpu_seconds(
            modality="text-generation", method="lora", cardinality=2000, epochs=3
        )
        assert more == one * 2 * 3  # linear in both

    def test_video_costs_more_than_text_for_the_same_job(self) -> None:
        text = estimate_gpu_seconds(
            modality="text-generation", method="lora", cardinality=500, epochs=1
        )
        video = estimate_gpu_seconds(
            modality="text-to-video", method="lora", cardinality=500, epochs=1
        )
        assert video > text

    def test_it_is_deterministic(self) -> None:
        def _est() -> float:
            return estimate_gpu_seconds(
                modality="text-generation", method="qlora", cardinality=1234, epochs=2
            )

        assert _est() == _est()


class TestEpochsOf:
    def test_it_reads_hyperparams(self) -> None:
        assert epochs_of({"hyperparams": {"epochs": 5}}) == 5

    def test_a_missing_or_malformed_epoch_count_floors_at_one(self) -> None:
        assert epochs_of({}) == 1
        assert epochs_of({"hyperparams": {"epochs": "lots"}}) == 1
        assert epochs_of({"hyperparams": {"epochs": 0}}) == 1
