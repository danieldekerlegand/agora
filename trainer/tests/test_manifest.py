"""The KCB `finetune` capability manifest (koine/specs/capability-bus.md §2, KFT §2)."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest

from agora_trainer import KCB_VERSION, TRAINER_IDENTITY
from agora_trainer.config import BASE_URL_ENV
from agora_trainer.manifest import (
    AGENT_CARD_PATH,
    CAPABILITY_NAME,
    INVOKE_PATH,
    MANIFEST_PATH,
    WEIGHTS_MEDIA_TYPES,
    capability_manifest,
)
from agora_trainer.modality import MODALITIES
from agora_trainer.records import RECORDS_MEDIA_TYPE, RECORDS_SHAPE
from conftest import config_for


def manifest_for(**env: str) -> dict[str, Any]:
    return capability_manifest(config_for(**env))


def caps_for_modality(manifest: dict[str, Any], modality: str) -> dict[str, Any]:
    found = next(c for c in manifest["capabilities"] if c["modality"] == modality)
    assert isinstance(found, dict)
    return found


class TestShape:
    def test_it_declares_the_spec_version_and_a_kinp_identity(self) -> None:
        manifest = manifest_for()
        assert manifest["kcb_version"] == KCB_VERSION
        assert manifest["identity"] == TRAINER_IDENTITY
        assert manifest["identity"].startswith("agora:agent:")

    def test_one_finetune_capability_per_modality(self) -> None:
        manifest = manifest_for()
        assert {c["name"] for c in manifest["capabilities"]} == {CAPABILITY_NAME}
        assert [c["modality"] for c in manifest["capabilities"]] == [m.name for m in MODALITIES]

    def test_endpoints_follow_the_configured_public_base_url(self) -> None:
        manifest = manifest_for(**{BASE_URL_ENV: "https://trainer.example/"})
        assert manifest["endpoints"]["manifest"] == f"https://trainer.example{MANIFEST_PATH}"
        assert manifest["endpoints"]["a2a"] == f"https://trainer.example{AGENT_CARD_PATH}"

    def test_it_advertises_no_endpoint_it_does_not_serve(self) -> None:
        """A manifest address is a promise a peer will dial directly (ADR-0001 decision 3)."""
        assert set(manifest_for()["endpoints"]) == {
            "a2a",
            "invoke",
            "subscribe",
            "health",
            "manifest",
        }

    def test_every_capability_carries_the_invoke_endpoint_a_caller_dials(self) -> None:
        """`endpointFor` prefers a capability's own endpoint — so it must be the invoke URL.

        A bridge that discovered this trainer by capability (KFT §8) posts a job manifest to
        whatever came back. Without this it would get the agent card and POST a job at it.
        """
        manifest = manifest_for(**{BASE_URL_ENV: "https://trainer.example"})
        assert {c["endpoint"] for c in manifest["capabilities"]} == {
            f"https://trainer.example{INVOKE_PATH}"
        }
        assert manifest["endpoints"]["invoke"] == f"https://trainer.example{INVOKE_PATH}"

    def test_auth_declares_the_finetune_grant_and_spend_ceiling(self) -> None:
        auth = manifest_for()["auth"]
        assert auth["scheme"] == "capability-token"
        assert auth["grants_required"] == [f"invoke:{CAPABILITY_NAME}"]
        assert auth["budget_units"]["supported"] is True
        assert auth["budget_units"]["meter"] == "gpu-seconds"


class TestPorts:
    def test_ports_span_planes_data_in_model_out(self) -> None:
        """KFT §2: entity + knowledge/media in, entity + media out — one cross-plane capability."""
        text = caps_for_modality(manifest_for(), "text-generation")
        base = next(p for p in text["inputs"] if p["plane"] == "entity")
        assert base == {
            "plane": "entity",
            "types": ["model", "text-generation"],
            "shape": "base-model",
        }
        assert any(p["plane"] == "knowledge" for p in text["inputs"])
        out_model = next(p for p in text["outputs"] if p["plane"] == "entity")
        assert out_model["shape"] == "finetuned-model"
        weights = next(p for p in text["outputs"] if p["plane"] == "media")
        assert weights["media_types"] == list(WEIGHTS_MEDIA_TYPES)

    def test_text_generation_consumes_knowledge_plus_the_record_files(self) -> None:
        """Its corpus is knowledge — but a producer's exhaust arrives on the records port (FT-M)."""
        text = caps_for_modality(manifest_for(), "text-generation")
        assert {p["plane"] for p in text["inputs"]} == {"entity", "knowledge", "media"}
        media = [p for p in text["inputs"] if p["plane"] == "media"]
        assert media == [
            {
                "plane": "media",
                "media_types": [RECORDS_MEDIA_TYPE],
                "world_pattern": "*",
                "shape": RECORDS_SHAPE,
            }
        ]

    def test_every_modality_accepts_the_training_records_port(self) -> None:
        """KFT §2/§4.1: a training-record JSONL is path-searchable on every modality (FT-M)."""
        manifest = manifest_for()
        for m in MODALITIES:
            inputs = caps_for_modality(manifest, m.name)["inputs"]
            assert any(
                p.get("shape") == RECORDS_SHAPE and p["media_types"] == [RECORDS_MEDIA_TYPE]
                for p in inputs
            ), m.name

    def test_multimodal_modalities_consume_media(self) -> None:
        """text-to-image / -video ride the media plane; VLM rides both (KFT §3.1/§4.1)."""
        t2i = caps_for_modality(manifest_for(), "text-to-image")
        media = next(p for p in t2i["inputs"] if p["plane"] == "media")
        assert media["media_types"] == ["image/*"]
        assert media["shape"] == "training-set"

        vlm = caps_for_modality(manifest_for(), "image-text-to-text")
        assert {p["plane"] for p in vlm["inputs"]} == {"entity", "knowledge", "media"}

    def test_the_modality_rides_the_entity_port_types(self) -> None:
        """§5.1 model-entity `modality` refinement — what makes find-by-modality work."""
        for m in MODALITIES:
            out = next(
                p
                for p in caps_for_modality(manifest_for(), m.name)["outputs"]
                if p["plane"] == "entity"
            )
            assert out["types"] == ["model", m.name]


class TestCost:
    def test_cost_is_metered_in_gpu_seconds(self) -> None:
        """Fine-tuning's natural unit — the KCB cost/grant machinery is load-bearing (KFT §2/§7)."""
        for entry in manifest_for()["capabilities"]:
            assert entry["cost"]["meter"] == "gpu-seconds"
            assert entry["cost"]["est_units"] > 0
            assert entry["cost"]["unpriced"] is False

    def test_it_advertises_only_the_general_methods_it_serves(self) -> None:
        """US-5 leans on this: the general surface is broad, distinguishable from a specialist."""
        text = caps_for_modality(manifest_for(), "text-generation")
        assert text["methods"] == ["sft", "lora", "qlora", "full", "dpo"]
        assert caps_for_modality(manifest_for(), "text-to-video")["methods"] == ["lora"]


class TestSeparateFromProviderRouter:
    """ADR-0001 decision 1: the trainer is a DISTINCT leaf capability, never merged."""

    def test_the_trainer_does_not_import_the_provider_router(self) -> None:
        pkg = Path(__file__).resolve().parents[1] / "src" / "agora_trainer"
        for source in pkg.rglob("*.py"):
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            for node in ast.walk(tree):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                assert not any(name.startswith("agora_provider_router") for name in names), (
                    f"{source} imports the provider-router (ADR-0001 decision 1)"
                )

    def test_the_manifest_advertises_finetune_not_generation(self) -> None:
        names = {c["name"] for c in manifest_for()["capabilities"]}
        assert names == {"finetune"}
        assert not any(n.startswith("generate.") for n in names)


class TestTheRegistryFixture:
    """The TypeScript registry (US-1) indexes a captured copy of this manifest.

    ``registry/src/fixtures/trainer.manifest.json`` is the default manifest, byte-for-byte, so
    the registry's tests exercise the provider they will actually meet rather than a hand-written
    idea of it. This asserts the capture is still current — the same cross-language pin as the KCB
    version. If it fails, regenerate the fixture rather than editing it.
    """

    FIXTURE = (
        Path(__file__).resolve().parents[2]
        / "registry"
        / "src"
        / "fixtures"
        / "trainer.manifest.json"
    )

    @pytest.mark.skipif(
        not FIXTURE.exists(),
        reason=f"standalone checkout: {FIXTURE} (the TS registry fixture) is absent",
    )
    def test_the_captured_fixture_still_matches_what_the_trainer_publishes(self) -> None:
        captured = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        assert captured == manifest_for(), (
            f"{self.FIXTURE} is stale; regenerate it with:\n"
            "  cd trainer && uv run python -c 'import json;"
            "from agora_trainer.config import TrainerConfig;"
            "from agora_trainer.manifest import capability_manifest;"
            "print(json.dumps(capability_manifest(TrainerConfig.from_env({})), indent=2))'"
            f" > {self.FIXTURE}"
        )
