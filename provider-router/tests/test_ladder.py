"""The ladder is configuration, and the placeholder is not negotiable."""

from __future__ import annotations

import pytest

from agora_provider_router.ladder import (
    DEFAULT_LADDERS,
    MODALITIES,
    PLACEHOLDER,
    TIERS,
    resolve_all,
    resolve_ladder,
    safe_resolve,
)


def test_every_modality_defaults_to_the_full_cloud_first_order() -> None:
    for modality in MODALITIES:
        assert resolve_ladder(modality, {}) == TIERS
        assert DEFAULT_LADDERS[modality][0] == "paid"


def test_an_env_override_narrows_and_reorders() -> None:
    assert resolve_ladder("text", {"AGORA_TEXT_LADDER": "local, mlx"}) == ("local", "mlx")
    assert resolve_ladder("text", {"AGORA_TEXT_LADDER": "local,local,paid"}) == ("local", "paid")


def test_prefer_local_fronts_the_zero_spend_tiers() -> None:
    env = {"AGORA_PREFER_LOCAL": "1"}
    assert resolve_ladder("text", env) == ("mlx", "local", "paid")
    # …and applies on top of an override rather than replacing it.
    assert resolve_ladder("text", {**env, "AGORA_TEXT_LADDER": "paid,local"}) == ("local", "paid")


def test_the_placeholder_is_not_a_ladder_token_but_is_always_the_last_rung() -> None:
    # Naming it is redundant, not an error — but it can never be configured away.
    assert resolve_ladder("text", {"AGORA_TEXT_LADDER": f"paid,{PLACEHOLDER}"}) == ("paid",)
    assert PLACEHOLDER not in TIERS
    for entry in resolve_all({}).values():
        assert entry["ladder"][-1] == PLACEHOLDER


def test_an_unknown_tier_is_rejected_with_the_valid_tokens() -> None:
    with pytest.raises(ValueError, match="AGORA_TEXT_LADDER: unknown text tier 'gpu'"):
        resolve_ladder("text", {"AGORA_TEXT_LADDER": "gpu"})
    with pytest.raises(ValueError, match="unknown ladder modality"):
        resolve_ladder("hologram", {})


def test_a_bad_ladder_var_degrades_loudly_instead_of_aborting() -> None:
    env = {"AGORA_TEXT_LADDER": "gpu", "AGORA_PREFER_LOCAL": "1"}
    tiers, error = safe_resolve("text", env)
    assert error is not None and "gpu" in error
    # The default order survives the rejection, prefer-local still honoured.
    assert tiers == ("mlx", "local", "paid")
    assert resolve_all(env)["text"]["source"] == "default"


def test_resolve_all_reports_every_modality_and_its_source() -> None:
    report = resolve_all({"AGORA_VIDEO_LADDER": "local"})
    assert set(report) == set(MODALITIES)
    assert report["video"]["source"] == "env"
    assert report["video"]["ladder"] == ["local", PLACEHOLDER]
    assert report["text"]["source"] == "default"
