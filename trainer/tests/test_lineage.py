"""Model / weight / export artifacts — identity, lineage & inheritance (KFT §5, FT-A/FT-C/FT-G)."""

from __future__ import annotations

from agora_trainer import lineage
from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY
from agora_trainer.resolve import RecordFacts, ResolvedInputs
from conftest import valid_text_job


def _resolved(*, base: str = EXPORTABLE, data: str = EXPORTABLE, **kw: object) -> ResolvedInputs:
    base_lic = kw.get("base_license")
    data_lic = kw.get("data_license")
    return ResolvedInputs(
        base=RecordFacts(
            ref="pinakes:model:qwen2.5-3b-instruct",
            egress=base,
            license=base_lic if isinstance(base_lic, str) else None,
        ),
        knowledge=(
            RecordFacts(
                ref="kgp:pack:sha256-7b1e",
                egress=data,
                license=data_lic if isinstance(data_lic, str) else None,
                samples=100,
            ),
        ),
    )


class TestModelIdentity:
    def test_the_model_id_is_minted_not_content_addressed(self) -> None:
        """FT-C: the id is a minted KINP `model` CURIE anchored to the run, not a byte hash."""
        model = lineage.mint_artifacts(valid_text_job(), _resolved()).model
        assert model.id.startswith("agora:model:ft-")
        assert model.modality == "text-generation"

    def test_the_same_run_mints_the_same_id_a_new_run_a_fresh_one(self) -> None:
        first = lineage.mint_artifacts(valid_text_job(), _resolved()).model.id
        again = lineage.mint_artifacts(valid_text_job(), _resolved()).model.id
        other = lineage.mint_artifacts(
            valid_text_job(job="orchestrator:activity:ft-run/other"), _resolved()
        ).model.id
        assert first == again  # deterministic in the §5.2 anchor
        assert other != first  # a new job id (FT-C) mints a distinct entity

    def test_the_model_links_to_its_base(self) -> None:
        """§5.1: based_on + derived_from the base entity (FT-G — the base is a minted entity)."""
        model = lineage.mint_artifacts(valid_text_job(), _resolved()).model
        assert model.based_on == "pinakes:model:qwen2.5-3b-instruct"
        assert model.derived_from == "pinakes:model:qwen2.5-3b-instruct"
        relations = {link.relation for link in model.links()}
        assert {"based_on", "derived_from"} <= relations
        assert model.retrains is None and model.supersedes is None

    def test_a_retrain_links_to_its_predecessor(self) -> None:
        """§5.2: a re-train mints a NEW entity linked via retrains/supersedes, never a collision."""
        predecessor = "agora:model:ft-earlier000000000"
        model = lineage.mint_artifacts(valid_text_job(), _resolved(), predecessor=predecessor).model
        assert model.retrains == predecessor
        assert model.supersedes == predecessor
        relations = {link.relation for link in model.links()}
        assert {"retrains", "supersedes"} <= relations


class TestRunActivity:
    def test_the_activity_records_used_and_generated(self) -> None:
        """§5.2 PROV: used = {base ∪ data}, generated = {model ∪ weights}, + the anchor."""
        bundle = lineage.mint_artifacts(valid_text_job(), _resolved())
        activity = bundle.activity
        assert activity.activity == "orchestrator:activity:ft-run/9f2a"
        assert "pinakes:model:qwen2.5-3b-instruct" in activity.used
        assert "kgp:pack:sha256-7b1e" in activity.used
        assert bundle.model.id in activity.generated
        assert set(bundle.weight_ids) <= set(activity.generated)
        assert activity.seed == 42
        assert activity.config_hash == "sha256-cfg9f2a"


class TestWeightLineage:
    def test_each_export_is_a_kmi_asset_with_matrix_media_types(self) -> None:
        """§5.3: primary safetensors adapter + each requested export, registered media types."""
        job = valid_text_job(export=["safetensors-adapter", "gguf:Q4_K_M", "onnx"])
        weights = lineage.mint_artifacts(job, _resolved()).weights
        by_role = {w.role: w for w in weights}
        assert by_role["adapter"].media_type == "application/vnd.koine.model+safetensors"
        assert by_role["gguf"].media_type == "application/vnd.koine.model+gguf"
        assert by_role["onnx"].media_type == "application/vnd.koine.model+onnx"
        assert all(w.id.startswith("sha256:") for w in weights)

    def test_the_export_matrix_is_the_lineage_graph(self) -> None:
        """§5.3: adapter derived_from base; each export variant_of the primary weights."""
        job = valid_text_job(export=["safetensors-adapter", "gguf:Q4_K_M"])
        weights = lineage.mint_artifacts(job, _resolved()).weights
        primary = weights[0]
        assert primary.role == "adapter"
        assert primary.lineage[0].relation == "media:derived_from"
        assert primary.lineage[0].target == "pinakes:model:qwen2.5-3b-instruct"
        gguf = weights[1]
        assert gguf.lineage[0].relation == "media:variant_of"
        assert gguf.lineage[0].target == primary.id


class TestInheritance:
    def test_output_inherits_the_most_restrictive_egress(self) -> None:
        """§5.4/FT-A: one local-only input makes the model + every weight asset local-only."""
        bundle = lineage.mint_artifacts(valid_text_job(), _resolved(data=LOCAL_ONLY))
        assert bundle.model.egress == LOCAL_ONLY
        assert all(w.egress == LOCAL_ONLY for w in bundle.weights)

    def test_a_local_only_base_pins_an_exportable_corpus(self) -> None:
        """FT-B: a can't-leave base makes the output local-only regardless of the data."""
        bundle = lineage.mint_artifacts(valid_text_job(), _resolved(base=LOCAL_ONLY))
        assert bundle.model.egress == LOCAL_ONLY

    def test_all_exportable_stays_exportable(self) -> None:
        bundle = lineage.mint_artifacts(valid_text_job(), _resolved())
        assert bundle.model.egress == EXPORTABLE
        assert all(w.egress == EXPORTABLE for w in bundle.weights)

    def test_output_inherits_the_union_license(self) -> None:
        """§5.4: the union of {data ∪ base} licenses — a non-commercial base taints the model."""
        bundle = lineage.mint_artifacts(
            valid_text_job(),
            _resolved(base_license="PROPRIETARY", data_license="CC-BY-4.0"),
        )
        assert bundle.model.license == ("CC-BY-4.0", "PROPRIETARY")
        assert all(w.license == ("CC-BY-4.0", "PROPRIETARY") for w in bundle.weights)
