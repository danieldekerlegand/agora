"""The budget gate: a ceiling forces the ladder down, and the cost is reported back.

The load-bearing assertion in most of these is on ``calls`` — the list of backends the
transport was actually handed. A refused rung must never be *contacted*, not merely never
preferred: the spend happens at the connection, so "it lost the race" is not the same
guarantee as "it was never dialed".
"""

from __future__ import annotations

from typing import Any

import pytest

from agora_provider_router.backends import Backend
from agora_provider_router.cost import BUDGET_KEY, RATES, project
from agora_provider_router.router import Completion, Router
from conftest import config_for, recording_transport, run

#: A configuration with every tier available: a paid key, an mlx-serve URL, an Ollama URL.
FULL_LADDER: dict[str, str] = {
    "OPENAI_API_KEY": "sk-test",
    "MLX_SERVE_BASE_URL": "http://mlx.test:9000/v1",
    "OLLAMA_BASE_URL": "http://ollama.test:11434/v1",
}

#: 1000 tokens of text on OpenAI — a request expensive enough for a ceiling to bite.
PROMPT: dict[str, Any] = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 1000}

#: What that costs on the paid tier, so the tests can state ceilings relative to it rather
#: than hardcoding a figure that moves whenever the rate table is corrected.
PAID_UNITS = project("text", "openai", PROMPT).units


def complete_with(calls: list[Backend], ceiling: float | None, /, **env: str) -> Completion:
    """Run ``PROMPT`` through a router on ``env``, recording every backend dialed.

    ``ceiling`` is positional-only: a named parameter alongside ``**env: str`` does not
    type-check, since the splat could supply it (the same trap ``conftest.router_for``
    documents).
    """
    router = Router(config_for(**env), recording_transport(calls))
    payload = dict(PROMPT) if ceiling is None else {**PROMPT, BUDGET_KEY: ceiling}
    return run(router.complete("text", payload))


class TestDownshift:
    def test_a_generous_ceiling_still_reaches_the_paid_tier(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, PAID_UNITS * 10, **FULL_LADDER)
        assert completion.tier == "paid"
        assert [c.provider for c in calls] == ["openai"]

    def test_a_ceiling_below_the_paid_price_downshifts_to_the_local_tier(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, PAID_UNITS / 2, **FULL_LADDER)
        assert completion.tier == "mlx"
        assert "openai" not in [c.provider for c in calls], "the paid rung was never contacted"

    def test_with_no_local_tier_the_ceiling_downshifts_all_the_way_to_placeholder(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, PAID_UNITS / 2, OPENAI_API_KEY="sk-test")
        assert completion.tier == "placeholder"
        assert calls == [], "nothing was dialed at all"

    def test_the_full_paid_to_local_to_placeholder_walk_is_recorded(self) -> None:
        """The ceiling refuses paid; mlx is configured but unreachable; placeholder answers."""
        calls: list[Backend] = []
        transport = recording_transport(calls, fail={"mlx", "local"})
        router = Router(config_for(**FULL_LADDER), transport)
        completion = run(router.complete("text", {**PROMPT, BUDGET_KEY: 0}))
        assert [(a.tier, a.ok, a.dialed) for a in completion.attempts] == [
            ("paid", False, False),
            ("mlx", False, True),
            ("local", False, True),
            ("placeholder", True, True),
        ]
        assert "openai" not in [c.provider for c in calls]

    def test_the_refusal_explains_itself_on_the_attempt(self) -> None:
        completion = complete_with([], 1.0, **FULL_LADDER)
        refused = next(a for a in completion.attempts if a.tier == "paid")
        assert refused.reason is not None
        assert "ceiling" in refused.reason
        assert refused.projected is not None
        assert refused.projected.units == PAID_UNITS

    def test_no_ceiling_means_no_constraint(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, None, **FULL_LADDER)
        assert completion.tier == "paid"
        assert completion.budget_units is None


class TestZeroCeilingNeverSpends:
    def test_a_zero_ceiling_resolves_to_the_placeholder_and_dials_nothing_paid(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, 0, OPENAI_API_KEY="sk-live", GROQ_API_KEY="gk")
        assert completion.tier == "placeholder"
        assert calls == []
        assert completion.actual.units == 0.0

    def test_a_zero_ceiling_still_allows_the_free_local_tiers(self) -> None:
        """Zero *spend*, not zero *service* — self-hosted compute costs no budget units."""
        calls: list[Backend] = []
        completion = complete_with(calls, 0, **FULL_LADDER)
        assert completion.tier == "mlx"
        assert completion.actual.units == 0.0

    def test_a_negative_ceiling_is_a_zero_ceiling_not_an_absent_one(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(calls, -100, **FULL_LADDER)
        assert completion.tier == "mlx"
        assert completion.budget_units == 0.0

    def test_an_unpriced_paid_vendor_is_refused_under_any_ceiling(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A vendor with no published rate cannot be *proven* affordable, so it is not tried."""
        monkeypatch.delitem(RATES["text"], "openai")
        calls: list[Backend] = []
        router = Router(config_for(**FULL_LADDER), recording_transport(calls))
        completion = run(router.complete("text", {**PROMPT, BUDGET_KEY: 10**9}))
        assert completion.tier == "mlx"
        assert "openai" not in [c.provider for c in calls]


class TestCheapestSatisfyingVendor:
    def test_a_ceiling_prefers_the_cheaper_of_two_usable_paid_vendors(self) -> None:
        """The ladder does not order vendors *within* the paid tier — cost does (KCB §3)."""
        calls: list[Backend] = []
        completion = complete_with(
            calls,
            PAID_UNITS * 10,
            OPENAI_API_KEY="sk-test",
            GROQ_API_KEY="gk-test",
            AGORA_PRICE_TEXT_GROQ="0.0001",
        )
        assert completion.backend.provider == "groq"

    def test_without_a_ceiling_the_declared_preference_order_stands(self) -> None:
        calls: list[Backend] = []
        completion = complete_with(
            calls,
            None,
            OPENAI_API_KEY="sk-test",
            GROQ_API_KEY="gk-test",
            AGORA_PRICE_TEXT_GROQ="0.0001",
        )
        assert completion.backend.provider == "openai", "cost only overrides when asked to"


class TestCostIsReported:
    def test_the_routing_report_carries_projected_and_actual_cost(self) -> None:
        completion = complete_with([], PAID_UNITS * 2, **FULL_LADDER)
        cost = completion.routing()["cost"]
        assert isinstance(cost, dict)
        assert cost["currency"] == "budget_units"
        assert cost["budget_units"] == PAID_UNITS * 2
        assert cost["projected_units"] == PAID_UNITS

    def test_actual_cost_follows_the_provider_reported_usage(self) -> None:
        calls: list[Backend] = []
        usage = {"usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}}
        router = Router(
            config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls, response=usage)
        )
        completion = run(router.complete("text", dict(PROMPT)))
        assert completion.projected.units == PAID_UNITS
        assert completion.actual.units == pytest.approx(10 * RATES["text"]["openai"])
        assert completion.actual.estimate is False

    def test_the_placeholder_settles_as_a_measured_zero(self) -> None:
        completion = complete_with([], 0)
        assert completion.actual.units == 0.0
        assert completion.actual.estimate is False, "the placeholder reports its own zero usage"

    def test_the_ceiling_never_reaches_the_provider(self) -> None:
        calls: list[Backend] = []
        seen: list[dict[str, Any]] = []

        async def transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
            calls.append(backend)
            seen.append(payload)
            return {"id": "ok"}

        router = Router(config_for(OPENAI_API_KEY="sk-test"), transport)
        run(router.complete("text", {**PROMPT, BUDGET_KEY: 10**6}))
        assert seen and BUDGET_KEY not in seen[0]
