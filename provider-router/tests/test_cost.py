"""The pricing primitives: sizing a request, looking up a rate, reading a ceiling.

Pure-function tests. The behavioural half — what the *router* does with these — is in
``test_budget.py``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

from agora_provider_router.cost import (
    BUDGET_KEY,
    BUDGET_UNITS_PER_USD,
    DEFAULT_COMPLETION_TOKENS,
    DEFAULT_SPEECH_CHARS,
    DEFAULT_VIDEO_SECONDS,
    PRICE_TABLE_ENV,
    Cost,
    measure,
    parse_ceiling,
    price_env_var,
    project,
    rate_for,
    refusal,
    settle,
    take_ceiling,
    within,
)
from agora_provider_router.litellm_prices import ENABLE_ENV, usd_rate_for

#: The canonical router's cost model, one area over. Read as text, never imported: the two
#: routers share a contract and no source (`CLAUDE.md`, ADR-0001), so the only thing that can
#: be pinned across the boundary is the number itself.
APR_COST = Path(__file__).resolve().parents[2] / "provider-router-erl" / "src" / "apr_cost.erl"


class TrappedLiteLLM:
    """A stand-in ``litellm``: a price map that answers, and a pricing call that is a landmine.

    ``cost_per_token`` is LiteLLM's own pricing entry point and it returns ``(0, 0)`` for a
    model it has never heard of — *free* where it means *unknown*. Raising here is how these
    tests assert the rule structurally rather than by inspection: any route into it fails the
    test that took it.
    """

    model_cost: dict[str, dict[str, float]] = {
        # $2 per million output tokens.
        "openai/gpt-5-pro": {"output_cost_per_token": 2e-6},
        # $0.05 per second — the worked example the shipped sheet documents its anchor with.
        "runway/gen-4": {"output_cost_per_video_per_second": 0.05},
    }

    def cost_per_token(self, *args: Any, **kwargs: Any) -> tuple[float, float]:
        raise AssertionError(
            "the cost model must never ask LiteLLM to price a model: it answers (0, 0) for "
            "one it does not know, which is 'free' where it means 'unknown'"
        )


class TestRates:
    def test_known_paid_provider_is_priced(self) -> None:
        rate, unpriced = rate_for("video", "runway")
        assert rate > 0
        assert unpriced is False

    def test_free_providers_are_zero_and_not_unpriced(self) -> None:
        for provider in ("mlx-serve", "ollama", "placeholder"):
            assert rate_for("text", provider) == (0.0, False)

    def test_unknown_provider_is_flagged_unpriced_not_free(self) -> None:
        rate, unpriced = rate_for("text", "some-new-vendor")
        assert rate == 0.0
        assert unpriced is True, "'we don't know' must not be indistinguishable from 'free'"

    def test_env_override_wins(self) -> None:
        env = {price_env_var("video", "runway"): "1.5"}
        assert rate_for("video", "runway", env) == (1.5, False)

    def test_override_can_price_a_normally_free_provider(self) -> None:
        env = {"AGORA_PRICE_TEXT_MLX_SERVE": "0.01"}
        assert rate_for("text", "mlx-serve", env) == (0.01, False)

    def test_malformed_override_leaves_the_table_rate_standing(self) -> None:
        for bad in ("banana", "-5", "inf", ""):
            env = {price_env_var("video", "runway"): bad}
            assert rate_for("video", "runway", env) == rate_for("video", "runway")

    def test_a_replacement_table_file_replaces_and_extends_rates(self, tmp_path: Path) -> None:
        sheet = tmp_path / "prices.toml"
        sheet.write_text("[rates.video]\nrunway = 99.0\nnewvendor = 42.0\n", encoding="utf-8")
        env = {PRICE_TABLE_ENV: str(sheet)}
        # a replaced rate wins over the shipped default...
        assert rate_for("video", "runway", env) == (99.0, False)
        assert project("video", "runway", {"duration": 2}, env).units == pytest.approx(198.0)
        # ...an added provider becomes priced (no longer unpriced)...
        assert rate_for("video", "newvendor", env) == (42.0, False)
        assert project("video", "newvendor", {"duration": 2}, env).units == pytest.approx(84.0)
        # ...and a per-rate override still wins over the replacement file.
        env[price_env_var("video", "runway")] = "1.0"
        assert rate_for("video", "runway", env) == (1.0, False)

    def test_a_missing_replacement_file_leaves_the_shipped_rate_standing(self) -> None:
        env = {PRICE_TABLE_ENV: "/no/such/prices.toml"}
        assert rate_for("video", "runway", env) == rate_for("video", "runway")

    def test_a_json_replacement_table_is_also_accepted(self, tmp_path: Path) -> None:
        sheet = tmp_path / "prices.json"
        sheet.write_text('{"rates": {"video": {"runway": 7.0}}}', encoding="utf-8")
        assert rate_for("video", "runway", {PRICE_TABLE_ENV: str(sheet)}) == (7.0, False)


class TestMeasure:
    def test_text_counts_prompt_and_requested_completion(self) -> None:
        payload = {"messages": [{"role": "user", "content": "x" * 350}], "max_tokens": 100}
        assert measure("text", payload) == pytest.approx(350 / 3.5 + 100)

    def test_text_reads_multimodal_content_parts(self) -> None:
        payload = {
            "messages": [{"role": "user", "content": [{"type": "text", "text": "x" * 70}]}],
            "max_tokens": 0,
        }
        assert measure("text", payload) == pytest.approx(20.0)

    def test_text_falls_back_to_a_conservative_default(self) -> None:
        assert measure("text", {}) == DEFAULT_COMPLETION_TOKENS

    def test_speech_measures_the_input_text(self) -> None:
        assert measure("speech", {"input": "hello"}) == 5.0
        assert measure("speech", {}) == DEFAULT_SPEECH_CHARS

    def test_video_multiplies_seconds_by_count(self) -> None:
        assert measure("video", {"duration": 3, "n": 2}) == 6.0
        assert measure("video", {}) == DEFAULT_VIDEO_SECONDS

    def test_image_and_music_count_generations(self) -> None:
        assert measure("image", {"n": 4}) == 4.0
        assert measure("music", {}) == 1.0

    def test_garbage_sizes_degrade_to_the_default(self) -> None:
        assert measure("video", {"duration": "soon"}) == DEFAULT_VIDEO_SECONDS
        assert measure("text", {"max_tokens": None}) == DEFAULT_COMPLETION_TOKENS


class TestProjectAndSettle:
    def test_projection_is_rate_times_quantity(self) -> None:
        cost = project("video", "runway", {"duration": 4})
        assert cost.quantity == 4.0
        assert cost.units == pytest.approx(cost.rate * 4)
        assert cost.estimate is True

    def test_the_placeholder_projects_zero(self) -> None:
        assert project("video", "placeholder", {"duration": 600}).units == 0.0

    def test_settle_reads_reported_token_usage(self) -> None:
        response = {"usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}}
        cost = settle("text", "openai", {"max_tokens": 1000}, response)
        assert cost.quantity == 7.0
        assert cost.estimate is False, "a reported usage block is a measurement, not a guess"

    def test_settle_falls_back_to_the_projection_when_usage_is_absent(self) -> None:
        cost = settle("text", "openai", {"max_tokens": 50}, {"choices": []})
        assert cost.quantity == 50.0
        assert cost.estimate is True

    def test_settle_counts_returned_media_items(self) -> None:
        response = {"data": [{"b64_json": "a"}, {"b64_json": "b"}]}
        cost = settle("image", "openai", {"n": 5}, response)
        assert cost.quantity == 2.0, "billing follows what came back, not what was asked for"
        assert cost.estimate is False


class TestCeiling:
    def test_within_is_unconstrained_without_a_ceiling(self) -> None:
        assert within(project("video", "runway", {"duration": 60}), None) is True

    def test_within_compares_against_the_ceiling(self) -> None:
        cost = Cost(units=10.0, unit="token", quantity=1.0, rate=10.0)
        assert within(cost, 10.0) is True
        assert within(cost, 9.99) is False

    def test_an_unpriced_rung_never_satisfies_a_ceiling(self) -> None:
        cost = project("text", "some-new-vendor", {"max_tokens": 1})
        assert cost.units == 0.0
        assert within(cost, 1_000_000.0) is False, "unknown price must not read as affordable"

    def test_take_ceiling_strips_the_key_from_the_body(self) -> None:
        payload = {"messages": [], BUDGET_KEY: 25}
        body, ceiling = take_ceiling(payload)
        assert ceiling == 25.0
        assert BUDGET_KEY not in body, "an agora extension must not reach an upstream provider"
        assert BUDGET_KEY in payload, "the caller's dict is not mutated"

    def test_absent_ceiling_is_none(self) -> None:
        assert take_ceiling({"messages": []}) == ({"messages": []}, None)

    def test_negative_ceilings_clamp_to_zero(self) -> None:
        assert parse_ceiling(-5) == 0.0

    @pytest.mark.parametrize("bad", ["banana", True, float("inf"), float("nan"), {}, []])
    def test_unreadable_ceilings_are_rejected_not_ignored(self, bad: object) -> None:
        with pytest.raises(ValueError, match=BUDGET_KEY):
            parse_ceiling(bad)

    def test_refusal_explains_the_arithmetic_without_naming_a_secret(self) -> None:
        cost = project("video", "runway", {"duration": 10})
        message = refusal(cost, 100.0, "video", "runway")
        assert "100" in message
        assert "exceeds" in message


class TestTheKeptRulesUnderARateSource:
    """The three rules that stay hand-built, re-asserted with a rate source underneath them.

    ``docs/router-hand-built-behaviours.md`` §2.2 keeps three things out of any borrowed
    pricing library: ``unpriced`` is not free, the denomination is KCB ``budget_units``, and
    the non-text ``measure()`` sizes seconds, characters and generations. The LiteLLM price
    map (:mod:`agora_provider_router.litellm_prices`) now feeds rates *underneath* them, so
    each rule is asserted again here with the source switched on — the classes above are the
    same three rules with it off, which is the other half of the same contract.

    What the source may fill in is :mod:`tests.test_litellm_prices`' subject. What it may
    never move is this one's.
    """

    @pytest.fixture
    def sourced(self, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
        """The source switched on over :class:`TrappedLiteLLM`'s map."""
        monkeypatch.setitem(sys.modules, "litellm", TrappedLiteLLM())
        return {ENABLE_ENV: "1"}

    def test_a_model_no_layer_prices_stays_unpriced_never_zero(
        self, sourced: dict[str, str], tmp_path: Path
    ) -> None:
        sheet = tmp_path / "prices.toml"
        sheet.write_text("[rates.text]\nopenai = 0.5\n", encoding="utf-8")
        env = {**sourced, PRICE_TABLE_ENV: str(sheet)}
        assert rate_for("text", "some-new-vendor", env, model="no-such-model") == (0.0, True)
        cost = project("text", "some-new-vendor", {"max_tokens": 1}, env, model="no-such-model")
        assert cost.units == 0.0
        assert within(cost, 1_000_000.0) is False, "an unmapped model must stay refusable"
        assert "no published text rate" in refusal(cost, 1e6, "text", "some-new-vendor")

    def test_a_miss_falls_through_the_source_rather_than_pricing_zero(
        self, sourced: dict[str, str]
    ) -> None:
        # A model the map does not carry is a missing key, so the layer under it still stands
        # — and the trapped ``cost_per_token``, which would have called it $0, is not reached.
        assert rate_for("text", "openai", sourced, model="no-such-model") == rate_for(
            "text", "openai"
        )

    def test_a_sourced_rate_arrives_denominated_in_budget_units(
        self, sourced: dict[str, str]
    ) -> None:
        # The source answers in the vendor's currency...
        assert usd_rate_for("video", "runway", "gen-4", sourced) == 0.05
        # ...and the cost model, not the source, says what a budget unit is.
        rate, unpriced = rate_for("video", "runway", sourced, model="gen-4")
        assert unpriced is False
        assert rate == pytest.approx(0.05 * BUDGET_UNITS_PER_USD)
        assert rate == 5000.0, "the anchor the shipped sheet documents: $0.05/second"
        assert rate_for("text", "openai", sourced, model="gpt-5-pro")[0] == pytest.approx(0.2)

    def test_a_ceiling_is_compared_in_budget_units_not_dollars(
        self, sourced: dict[str, str]
    ) -> None:
        cost = project("video", "runway", {"duration": 2}, sourced, model="gen-4")
        assert cost.units == 10_000.0  # 2 seconds x 5000 units
        assert within(cost, 10_000.0) is True
        # $0.10 would have bought this; a ceiling of 0.10 *units* must not.
        assert within(cost, 0.10) is False

    def test_the_non_text_measure_is_untouched_by_the_source(self, sourced: dict[str, str]) -> None:
        # ``measure`` takes neither env nor model: a request's cost is quantity x rate, and a
        # rate source may only move the rate. Asserted through ``project``, where the two meet.
        video = project("video", "runway", {"duration": 3, "n": 2}, sourced, model="gen-4")
        assert (video.quantity, video.unit) == (6.0, "second")
        speech = project("speech", "elevenlabs", {"input": "hello"}, sourced, model="gen-4")
        assert (speech.quantity, speech.unit) == (5.0, "character")
        images = project("image", "openai", {"n": 3}, sourced, model="gen-4")
        assert (images.quantity, images.unit) == (3.0, "image")
        # And each still errs high when the request states no size.
        bare = project("video", "runway", {}, sourced, model="gen-4")
        assert bare.quantity == DEFAULT_VIDEO_SECONDS
        assert project("speech", "elevenlabs", {}, sourced).quantity == DEFAULT_SPEECH_CHARS

    @pytest.mark.skipif(
        not APR_COST.exists(),
        reason="standalone checkout: the canonical router's cost model is absent",
    )
    def test_the_canonical_router_anchors_a_budget_unit_identically(self) -> None:
        # The lockstep half. A ceiling travels between the two routers, so it is only a
        # comparable scalar while both denominate it the same way — and the Python router is
        # now the one that converts a currency-denominated source. ``apr_conformance_SUITE``
        # pins this from the other side; this one runs where rebar3 is not installed.
        pin = r"budget_units_per_usd\(\) -> ([0-9][0-9_]*\.[0-9]+)"
        anchor = re.search(pin, APR_COST.read_text("utf-8"))
        assert anchor is not None, "apr_cost must state the anchor as budget_units_per_usd/0"
        assert float(anchor.group(1).replace("_", "")) == BUDGET_UNITS_PER_USD, (
            "the two cost models disagree on what a budget unit is worth — bump apr_cost.erl "
            "and cost.py together, or a ceiling means two different things on the two routers"
        )
