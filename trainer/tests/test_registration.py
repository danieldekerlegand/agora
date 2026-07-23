"""Output-egress enforcement at registration — the §5.4 cross-boundary refusal (FT-A)."""

from __future__ import annotations

import pytest

from agora_trainer import lineage
from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY
from agora_trainer.registration import (
    RegistrationRejected,
    assert_registrable,
    register_bundle,
)
from agora_trainer.resolve import RecordFacts, ResolvedInputs
from conftest import valid_text_job


def _bundle(egress: str) -> lineage.ArtifactBundle:
    resolved = ResolvedInputs(
        base=RecordFacts(ref="pinakes:model:qwen2.5-3b-instruct", egress=egress),
        knowledge=(RecordFacts(ref="kgp:pack:sha256-7b1e", egress=egress, samples=100),),
    )
    return lineage.mint_artifacts(valid_text_job(), resolved)


class TestCrossBoundary:
    def test_a_local_only_model_cannot_be_registered_across_the_boundary(self) -> None:
        """AC3 / FT-A: the registry refuses a cross-boundary registration of a local-only model."""
        bundle = _bundle(LOCAL_ONLY)
        with pytest.raises(RegistrationRejected) as caught:
            register_bundle(bundle, across_boundary=True)
        assert caught.value.problem.code == "egress-output"

    def test_the_refusal_also_covers_every_weight_asset(self) -> None:
        """§5.4: the model AND every weight/export asset inherit and are gated on the class."""
        bundle = _bundle(LOCAL_ONLY)
        for asset in bundle.weights:
            assert asset.egress == LOCAL_ONLY
        with pytest.raises(RegistrationRejected):
            register_bundle(bundle, across_boundary=True)

    def test_assert_registrable_raises_for_a_local_only_model(self) -> None:
        with pytest.raises(RegistrationRejected):
            assert_registrable(_bundle(LOCAL_ONLY).model, across_boundary=True)


class TestPermitted:
    def test_a_local_only_model_may_register_in_tier(self) -> None:
        """§5.4 keeps local-only output IN-tier — an in-tier registration is what's allowed."""
        registered = register_bundle(_bundle(LOCAL_ONLY), across_boundary=False)
        assert registered.model.startswith("agora:model:ft-")
        assert registered.across_boundary is False
        assert registered.assets

    def test_an_exportable_model_registers_across_the_boundary(self) -> None:
        bundle = _bundle(EXPORTABLE)
        registered = register_bundle(bundle, across_boundary=True)
        assert registered.model == bundle.model.id
        assert set(registered.assets) == set(bundle.weight_ids)
