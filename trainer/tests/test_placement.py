"""SkyPilot placement under the §4.2 egress gate — local-only pins, exportable may burst (FT-J)."""

from __future__ import annotations

import pytest

from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY
from agora_trainer.placement import (
    CLOUD_TIER,
    LOCAL_TIER,
    PlacementRejected,
    is_local_class,
    select_placement,
)


class TestIsLocalClass:
    def test_local_classes_are_local(self) -> None:
        assert is_local_class("local-mps")
        assert is_local_class("local-gpu")
        assert is_local_class("local")

    def test_a_named_cloud_gpu_class_is_not_local(self) -> None:
        assert not is_local_class("single-gpu-a100-80gb")


class TestLocalOnly:
    def test_a_cross_boundary_class_is_rejected_never_downgraded(self) -> None:
        with pytest.raises(PlacementRejected) as caught:
            select_placement(
                effective_egress=LOCAL_ONLY,
                requested_class="single-gpu-a100-80gb",
                modality="text-generation",
            )
        assert caught.value.problem.code == "egress-cross-boundary"

    def test_a_modality_the_local_tier_cannot_run_is_ft_j_unsatisfiable(self) -> None:
        with pytest.raises(PlacementRejected) as caught:
            select_placement(
                effective_egress=LOCAL_ONLY,
                requested_class="local-mps",  # a *local* class — still unplaceable (FT-J)
                modality="text-to-video",
            )
        assert caught.value.problem.code == "egress-unsatisfiable"

    def test_a_runnable_local_only_job_pins_local(self) -> None:
        placement = select_placement(
            effective_egress=LOCAL_ONLY, requested_class="local-mps", modality="text-generation"
        )
        assert placement.tier == LOCAL_TIER and placement.is_local


class TestExportable:
    def test_a_cloud_class_may_burst_to_cloud(self) -> None:
        placement = select_placement(
            effective_egress=EXPORTABLE,
            requested_class="single-gpu-a100-80gb",
            modality="text-generation",
        )
        assert placement.tier == CLOUD_TIER and not placement.is_local

    def test_a_local_class_still_runs_local(self) -> None:
        placement = select_placement(
            effective_egress=EXPORTABLE, requested_class="local-mps", modality="text-generation"
        )
        assert placement.tier == LOCAL_TIER
