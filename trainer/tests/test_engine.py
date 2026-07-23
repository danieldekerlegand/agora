"""The engine-adapter interface + selection (KFT §9), and the LLaMA-Factory rung."""

from __future__ import annotations

import pytest

from agora_trainer.diffusers import DiffusersAdapter
from agora_trainer.engine import EngineAdapter, UnsupportedJob, select_adapter
from agora_trainer.llama_factory import LlamaFactoryAdapter

LADDER = (LlamaFactoryAdapter(), DiffusersAdapter())


class TestSelection:
    def test_text_generation_selects_llama_factory(self) -> None:
        adapter = select_adapter("text-generation", "qlora", LADDER)
        assert isinstance(adapter, LlamaFactoryAdapter)
        assert adapter.name == "llama-factory"

    @pytest.mark.parametrize("modality", ["image-text-to-text", "video-text-to-text"])
    def test_the_vlm_modalities_select_llama_factory(self, modality: str) -> None:
        assert isinstance(select_adapter(modality, "lora", LADDER), LlamaFactoryAdapter)

    @pytest.mark.parametrize("modality", ["text-to-image", "text-to-video"])
    def test_the_media_modalities_select_diffusers(self, modality: str) -> None:
        assert isinstance(select_adapter(modality, "lora", LADDER), DiffusersAdapter)

    def test_an_unserved_modality_raises_unsupported(self) -> None:
        """No rung serves this token — a distinct, honest failure from an incompatible pair (§9)."""
        with pytest.raises(UnsupportedJob):
            select_adapter("text-to-speech", "lora", LADDER)


class TestLlamaFactorySurface:
    def test_it_satisfies_the_engine_adapter_protocol(self) -> None:
        assert isinstance(LlamaFactoryAdapter(), EngineAdapter)

    @pytest.mark.parametrize(
        ("modality", "method"),
        [
            ("text-generation", "sft"),
            ("text-generation", "lora"),
            ("text-generation", "qlora"),
            ("image-text-to-text", "lora"),
            ("image-text-to-text", "qlora"),
            ("video-text-to-text", "lora"),
        ],
    )
    def test_it_serves_text_generation_and_vlm(self, modality: str, method: str) -> None:
        assert LlamaFactoryAdapter().supports(modality, method)

    @pytest.mark.parametrize(
        ("modality", "method"),
        [("text-generation", "dpo"), ("text-generation", "full"), ("text-to-image", "lora")],
    )
    def test_it_declines_what_it_does_not_run(self, modality: str, method: str) -> None:
        assert not LlamaFactoryAdapter().supports(modality, method)


class TestDiffusersSurface:
    def test_it_satisfies_the_engine_adapter_protocol(self) -> None:
        assert isinstance(DiffusersAdapter(), EngineAdapter)

    @pytest.mark.parametrize(
        ("modality", "method"),
        [("text-to-image", "lora"), ("text-to-image", "full"), ("text-to-video", "lora")],
    )
    def test_it_serves_the_media_modalities(self, modality: str, method: str) -> None:
        assert DiffusersAdapter().supports(modality, method)

    @pytest.mark.parametrize(
        ("modality", "method"),
        [("text-to-video", "full"), ("text-generation", "lora"), ("image-text-to-text", "lora")],
    )
    def test_it_declines_what_it_does_not_run(self, modality: str, method: str) -> None:
        assert not DiffusersAdapter().supports(modality, method)

    def test_the_recorded_run_is_monotonic_with_decreasing_loss(self) -> None:
        adapter = LlamaFactoryAdapter()
        records = list(adapter.launch({"job": "j"}, adapter.prepare_data({})))
        steps = [r.step for r in records]
        assert steps == sorted(steps) and len(set(steps)) == len(steps)
        losses = [r.metrics["train_loss"] for r in records]
        assert losses == sorted(losses, reverse=True)
