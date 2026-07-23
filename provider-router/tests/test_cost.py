"""The pricing primitives: sizing a request, looking up a rate, reading a ceiling.

Pure-function tests. The behavioural half — what the *router* does with these — is in
``test_budget.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agora_provider_router.cost import (
    BUDGET_KEY,
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
