"""Admission — the composed KFT §3/§4.2/§7 gate: egress, placement, and the spend ceiling."""

from __future__ import annotations

from agora_trainer.admission import admit
from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY
from agora_trainer.grant import Grant
from agora_trainer.placement import CLOUD_TIER, LOCAL_TIER
from agora_trainer.resolve import RecordFacts, ResolvedInputs, static_resolver
from conftest import valid_text_job


def _inputs(
    *, base: str = EXPORTABLE, data: str = EXPORTABLE, samples: int = 100
) -> ResolvedInputs:
    """Resolved inputs with an explicit base + one knowledge record at the given egress classes."""
    return ResolvedInputs(
        base=RecordFacts(ref="pinakes:model:qwen2.5-3b-instruct", egress=base),
        knowledge=(RecordFacts(ref="kgp:pack:sha256-7b1e", egress=data, samples=samples),),
    )


class TestHappyPath:
    def test_a_valid_exportable_job_is_admitted_with_a_plan(self) -> None:
        admission = admit(valid_text_job())
        assert admission.ok
        assert admission.plan is not None
        assert admission.plan.effective_egress == EXPORTABLE
        assert admission.plan.placement.tier == LOCAL_TIER  # local-mps requested
        assert admission.plan.estimate_units > 0

    def test_an_exportable_job_may_be_placed_on_cloud(self) -> None:
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "derived"})
        admission = admit(job)
        assert admission.ok and admission.plan is not None
        assert admission.plan.placement.tier == CLOUD_TIER  # exportable → may burst


class TestEgressGate:
    def test_an_explicit_local_only_pin_rejects_a_cross_boundary_class(self) -> None:
        # AC3's local-only cloud-placement rejection — never silently downgraded (KFT §4.2).
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "local-only"})
        admission = admit(job)
        assert not admission.ok
        assert any(p.code == "egress-cross-boundary" for p in admission.report.problems)

    def test_a_local_only_data_record_pins_the_run_from_derived(self) -> None:
        # effective egress is computed over {data ∪ base}: one local-only record pins it (FT-B),
        # so a derived-egress job with a cloud class is rejected.
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "derived"})
        admission = admit(job, resolver=static_resolver(_inputs(data=LOCAL_ONLY)))
        assert not admission.ok
        assert any(p.code == "egress-cross-boundary" for p in admission.report.problems)

    def test_a_local_only_base_model_pins_an_exportable_corpus(self) -> None:
        # FT-B: a can't-leave base pins an all-exportable corpus to local compute.
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "derived"})
        admission = admit(job, resolver=static_resolver(_inputs(base=LOCAL_ONLY, data=EXPORTABLE)))
        assert not admission.ok
        assert any(p.code == "egress-cross-boundary" for p in admission.report.problems)

    def test_an_exportable_assertion_contradicted_by_the_data_is_rejected(self) -> None:
        job = valid_text_job(compute={"class": "local-mps", "egress": "exportable"})
        admission = admit(job, resolver=static_resolver(_inputs(data=LOCAL_ONLY)))
        assert not admission.ok
        assert any(p.code == "egress-assertion" for p in admission.report.problems)

    def test_a_local_only_video_job_is_unsatisfiable_on_the_local_tier(self) -> None:
        # FT-J: video-diffusion data pinned local on a tier that cannot run it → admission failure.
        job = valid_text_job(
            modality="text-to-video",
            method="lora",
            dataset={"media": ["analyzer:asset:blake3-a1b2c3"]},
            compute={"class": "local-mps", "egress": "local-only"},
        )
        admission = admit(job)
        assert not admission.ok
        assert any(p.code == "egress-unsatisfiable" for p in admission.report.problems)


class TestSpendGate:
    def test_a_run_over_the_grant_ceiling_is_rejected_before_provisioning(self) -> None:
        # default resolver → 1000 samples; text qlora over 3 epochs ≫ a 100 gpu-second ceiling.
        admission = admit(valid_text_job(), grant=Grant(budget_units=100))
        assert not admission.ok
        assert any(p.code == "budget" for p in admission.report.problems)

    def test_the_estimate_rides_the_resolved_cardinality_not_the_manifest_figure(self) -> None:
        # FT-E: a huge resolved corpus blows a ceiling a small one clears, on the same manifest.
        big = static_resolver(_inputs(samples=1_000_000))
        assert not admit(valid_text_job(), grant=Grant(budget_units=1000), resolver=big).ok
        small = static_resolver(_inputs(samples=10))
        assert admit(valid_text_job(), grant=Grant(budget_units=1000), resolver=small).ok

    def test_an_ungated_grant_admits_any_estimate(self) -> None:
        assert admit(valid_text_job(), grant=Grant()).ok


class TestOrdering:
    def test_a_shape_invalid_job_is_rejected_before_egress_or_cost(self) -> None:
        job = valid_text_job()
        del job["base_model"]
        admission = admit(job)
        assert not admission.ok
        assert any(p.code == "schema" for p in admission.report.problems)
        assert admission.plan is None
