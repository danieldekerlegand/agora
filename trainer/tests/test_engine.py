"""The engine-adapter interface + selection (KFT §9), and the LLaMA-Factory rung."""

from __future__ import annotations

import pytest

from agora_trainer.engine import EngineAdapter, UnsupportedJob, select_adapter
from agora_trainer.llama_factory import LlamaFactoryAdapter

LADDER = (LlamaFactoryAdapter(),)


class TestSelection:
    def test_text_generation_selects_llama_factory(self) -> None:
        adapter = select_adapter("text-generation", "qlora", LADDER)
        assert isinstance(adapter, LlamaFactoryAdapter)
        assert adapter.name == "llama-factory"

    def test_a_compatible_but_unwired_modality_raises_unsupported(self) -> None:
        """text-to-image is a compatible pair (FT-F) but has no US-2 engine — a distinct failure."""
        with pytest.raises(UnsupportedJob):
            select_adapter("text-to-image", "lora", LADDER)


class TestLlamaFactorySurface:
    def test_it_satisfies_the_engine_adapter_protocol(self) -> None:
        assert isinstance(LlamaFactoryAdapter(), EngineAdapter)

    @pytest.mark.parametrize("method", ["sft", "lora", "qlora"])
    def test_it_serves_text_generation_for_its_methods(self, method: str) -> None:
        assert LlamaFactoryAdapter().supports("text-generation", method)

    @pytest.mark.parametrize(
        ("modality", "method"),
        [("text-generation", "dpo"), ("text-generation", "full"), ("text-to-image", "lora")],
    )
    def test_it_declines_what_it_does_not_run(self, modality: str, method: str) -> None:
        assert not LlamaFactoryAdapter().supports(modality, method)

    def test_the_recorded_run_is_monotonic_with_decreasing_loss(self) -> None:
        adapter = LlamaFactoryAdapter()
        records = list(adapter.launch({"job": "j"}, adapter.prepare_data({})))
        steps = [r.step for r in records]
        assert steps == sorted(steps) and len(set(steps)) == len(steps)
        losses = [r.metrics["train_loss"] for r in records]
        assert losses == sorted(losses, reverse=True)
