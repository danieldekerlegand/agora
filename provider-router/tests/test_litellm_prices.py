"""The optional LiteLLM price map as a *source of rates* — what it may fill in, and what it
may never move.

Two halves, the same shape as ``test_litellm_dispatch.py``. The first is the addition: with
``AGORA_PRICE_LITELLM=1`` a model the map prices gets a real, model-exact rate where the
shipped sheet only had a per-provider estimate — or nothing at all. The second is the
load-bearing half: the layers above it. A deployer's ``AGORA_PRICE_TABLE`` entry and a
per-rate ``AGORA_PRICE_<MODALITY>_<PROVIDER>`` override still win, the zero-spend tiers are
still free, and a model the map does not price is *still unpriced* rather than free — the
source fills gaps, it never becomes the cost model.

LiteLLM is an optional extra, so the map is exercised against a stand-in module injected into
``sys.modules``: what is under test is which key agora looks up, which layer wins, and how the
number is denominated — none of which is a property of the real library's contents. The real
map is exercised separately by :class:`TestAgainstTheRealLibrary`, which skips when the extra
is absent.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from agora_provider_router import litellm_prices
from agora_provider_router.backends import Backend
from agora_provider_router.cost import (
    BUDGET_UNITS_PER_USD,
    PRICE_TABLE_ENV,
    RATES,
    price_env_var,
    project,
    rate_for,
)
from agora_provider_router.litellm_prices import COST_KEYS, ENABLE_ENV, LOCAL_MAP_ENV, usd_rate_for
from agora_provider_router.router import Router
from conftest import config_for, recording_transport, run

#: The source switched on: one variable, like the dispatch adapter's.
SOURCED: dict[str, str] = {ENABLE_ENV: "1"}

#: A stand-in for ``litellm.model_cost``. Two kinds of entry — provider-qualified and bare —
#: because the real map carries both, and every rate is in USD per unit, which is the whole
#: reason the cost model does the converting.
PRICE_MAP: dict[str, dict[str, Any]] = {
    # $2/M output tokens: 3× what the shipped per-provider estimate assumes for openai.
    "openai/gpt-5-pro": {
        "input_cost_per_token": 2.5e-7,
        "output_cost_per_token": 2e-6,
        "litellm_provider": "openai",
    },
    # A vendor the shipped sheet has never heard of — the breadth half.
    "mistral/mistral-large-latest": {"output_cost_per_token": 6e-6},
    # Listed under its bare id only, as plenty of the real map's models are.
    "claude-sonnet-4-5": {"output_cost_per_token": 1.5e-5},
    # Both spellings, disagreeing on purpose: the provider-qualified one is unambiguous.
    "gemini/gemini-2.5-flash": {"output_cost_per_token": 3e-7},
    "gemini-2.5-flash": {"output_cost_per_token": 9.9e-6},
    # The zero-spend tiers appear in the real map too — priced, which they are not to agora.
    "ollama/llama3.2": {"output_cost_per_token": 1e-6},
    # The non-text modalities, each under the key the real map uses for it.
    "elevenlabs-multilingual-v2": {"input_cost_per_character": 3e-4},
    "runway/gen-4": {"output_cost_per_video_per_second": 0.05},
    "openai/gpt-image-1": {"output_cost_per_image": 0.1},
    # A model the map lists but prices for a modality agora does not route it for.
    "replicate/musicgen": {"output_cost_per_token": 8e-6},
}


class FakeLiteLLM:
    """A ``litellm`` module that carries a price map and nothing else."""

    def __init__(self, model_cost: dict[str, dict[str, Any]]) -> None:
        self.model_cost = model_cost


@pytest.fixture
def price_map(monkeypatch: pytest.MonkeyPatch) -> FakeLiteLLM:
    """Install a stand-in ``litellm`` carrying :data:`PRICE_MAP` for the duration of a test."""
    fake = FakeLiteLLM(dict(PRICE_MAP))
    monkeypatch.setitem(sys.modules, "litellm", fake)
    return fake


@pytest.fixture
def no_litellm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the extra look uninstalled, whatever the developer's venv holds.

    ``None`` in ``sys.modules`` is how the import machinery itself spells "absent": the
    lookup raises ``ImportError``, so the real failure path is the one under test.
    """
    monkeypatch.setitem(sys.modules, "litellm", None)


class TestOffByDefault:
    """The default surface must be exactly what it was — the Erlang router has no LiteLLM."""

    def test_an_unpriced_model_stays_unpriced_without_the_variable(
        self, price_map: FakeLiteLLM
    ) -> None:
        assert rate_for("text", "mistral", model="mistral-large-latest") == (0.0, True)

    def test_a_priced_provider_keeps_the_shipped_rate_without_the_variable(
        self, price_map: FakeLiteLLM
    ) -> None:
        assert rate_for("text", "openai", model="gpt-5-pro") == (RATES["text"]["openai"], False)

    @pytest.mark.parametrize("off", ["", "0", "no", "off", " "])
    def test_only_a_truthy_value_switches_the_source_on(
        self, price_map: FakeLiteLLM, off: str
    ) -> None:
        assert rate_for("text", "mistral", {ENABLE_ENV: off}, model="mistral-large-latest") == (
            0.0,
            True,
        )

    def test_the_map_is_not_even_loaded_when_the_source_is_off(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No import, no ~166 MB, no work at all on the default path."""

        def explode() -> dict[str, Any]:
            raise AssertionError("the price map must not be consulted when the source is off")

        monkeypatch.setattr(litellm_prices, "_price_map", explode)
        assert rate_for("text", "openai", model="gpt-5-pro") == (RATES["text"]["openai"], False)


class TestWhatItFillsIn:
    """The addition: rates for models the hand-built sheet could not have."""

    def test_a_model_the_map_prices_resolves_a_non_zero_rate(self, price_map: FakeLiteLLM) -> None:
        rate, unpriced = rate_for("text", "mistral", SOURCED, model="mistral-large-latest")
        assert rate == 0.6, "$6/M output tokens = 6e-6 USD/token = 0.6 budget units/token"
        assert unpriced is False

    def test_it_is_model_exact_where_the_shipped_sheet_is_provider_flat(
        self, price_map: FakeLiteLLM
    ) -> None:
        """The point of the source: one estimate per provider cannot follow a model swap."""
        sourced, _ = rate_for("text", "openai", SOURCED, model="gpt-5-pro")
        assert sourced == 0.2
        assert sourced > RATES["text"]["openai"], "the dearer model must not price as the cheap one"

    def test_a_bare_model_id_is_found_too(self, price_map: FakeLiteLLM) -> None:
        assert rate_for("text", "anthropic", SOURCED, model="claude-sonnet-4-5") == (1.5, False)

    def test_the_provider_qualified_key_wins_over_the_bare_one(
        self, price_map: FakeLiteLLM
    ) -> None:
        """Both spellings exist in the real map and can disagree; the qualified one is ours."""
        assert rate_for("text", "gemini", SOURCED, model="gemini-2.5-flash") == (0.03, False)

    @pytest.mark.parametrize(
        ("modality", "provider", "model", "expected"),
        [
            ("speech", "elevenlabs", "elevenlabs-multilingual-v2", 30.0),
            ("video", "runway", "gen-4", 5000.0),
            ("image", "openai", "gpt-image-1", 10000.0),
        ],
    )
    def test_the_non_text_modalities_read_their_own_cost_key(
        self, price_map: FakeLiteLLM, modality: str, provider: str, model: str, expected: float
    ) -> None:
        assert rate_for(modality, provider, SOURCED, model=model) == (expected, False)

    def test_music_is_never_sourced(self, price_map: FakeLiteLLM) -> None:
        """LiteLLM has no music surface, so agora's own route stays priced by agora's sheet."""
        assert "music" not in COST_KEYS
        assert rate_for("music", "replicate", SOURCED, model="musicgen") == (
            RATES["music"]["replicate"],
            False,
        )

    def test_the_rate_is_denominated_in_budget_units_not_dollars(
        self, price_map: FakeLiteLLM
    ) -> None:
        """The source speaks USD; the conversion is the cost model's, at its own anchor."""
        usd = usd_rate_for("text", "mistral", "mistral-large-latest", SOURCED)
        assert usd == 6e-6
        rate, _ = rate_for("text", "mistral", SOURCED, model="mistral-large-latest")
        assert rate == pytest.approx(usd * BUDGET_UNITS_PER_USD)
        assert BUDGET_UNITS_PER_USD == 100_000.0, "1 budget unit = US$0.00001 (prices.toml)"

    def test_a_sourced_rate_reaches_the_reported_cost_of_a_real_completion(
        self, price_map: FakeLiteLLM
    ) -> None:
        """End to end: the ladder prices the rung it chose on the model it chose."""
        env = {"OPENAI_API_KEY": "sk-test", "AGORA_PROVIDER_OPENAI_MODEL": "gpt-5-pro", **SOURCED}
        dialed: list[Backend] = []
        router = Router(config_for(**env), transport=recording_transport(dialed))
        completion = run(router.complete("text", {"messages": [{"role": "user", "content": "hi"}]}))
        assert completion.backend.model == "gpt-5-pro"
        assert completion.projected.rate == 0.2
        assert completion.actual.rate == 0.2


class TestWhatItMayNeverMove:
    """The layers above the source. A sourced rate is data; the ones over it are decisions."""

    def test_a_per_rate_override_still_wins(self, price_map: FakeLiteLLM) -> None:
        env = {**SOURCED, price_env_var("text", "openai"): "0.01"}
        assert rate_for("text", "openai", env, model="gpt-5-pro") == (0.01, False)

    def test_a_price_table_entry_still_wins(self, price_map: FakeLiteLLM, tmp_path: Path) -> None:
        sheet = tmp_path / "prices.toml"
        sheet.write_text("[rates.text]\nopenai = 0.5\n", encoding="utf-8")
        env = {**SOURCED, PRICE_TABLE_ENV: str(sheet)}
        assert rate_for("text", "openai", env, model="gpt-5-pro") == (0.5, False)

    def test_the_zero_spend_tiers_are_never_priced_by_the_map(self, price_map: FakeLiteLLM) -> None:
        """The real map prices ``ollama/*``. agora's local tier is free by construction."""
        assert rate_for("text", "ollama", SOURCED, model="llama3.2") == (0.0, False)

    def test_a_model_the_map_does_not_price_falls_back_to_the_shipped_sheet(
        self, price_map: FakeLiteLLM
    ) -> None:
        assert rate_for("text", "openai", SOURCED, model="gpt-4o-mini") == (
            RATES["text"]["openai"],
            False,
        )

    def test_a_model_no_layer_prices_stays_unpriced_not_free(self, price_map: FakeLiteLLM) -> None:
        """The ``(0, 0)`` trap: an unmapped model is refusable, never the cheapest rung."""
        rate, unpriced = rate_for("text", "some-new-vendor", SOURCED, model="brand-new-1")
        assert rate == 0.0
        assert unpriced is True

    def test_pricing_without_a_model_is_unchanged(self, price_map: FakeLiteLLM) -> None:
        """Most callers price a provider; the source has nothing to say to them."""
        assert rate_for("text", "openai", SOURCED) == (RATES["text"]["openai"], False)
        assert rate_for("text", "mistral", SOURCED) == (0.0, True)


class TestAnAbsentSourceIsNotAnError:
    """An enabled source that cannot load degrades the price, it never fails the request."""

    def test_a_missing_extra_leaves_the_shipped_rate_standing(self, no_litellm: None) -> None:
        assert rate_for("text", "openai", SOURCED, model="gpt-5-pro") == (
            RATES["text"]["openai"],
            False,
        )

    def test_a_missing_extra_leaves_an_unknown_vendor_unpriced(self, no_litellm: None) -> None:
        assert rate_for("text", "mistral", SOURCED, model="mistral-large-latest") == (0.0, True)

    @pytest.mark.parametrize(
        "junk",
        [{"openai/gpt-5-pro": None}, {"openai/gpt-5-pro": {"output_cost_per_token": "free"}}, {}],
    )
    def test_a_map_that_does_not_answer_in_numbers_is_ignored(
        self, monkeypatch: pytest.MonkeyPatch, junk: dict[str, Any]
    ) -> None:
        monkeypatch.setitem(sys.modules, "litellm", FakeLiteLLM(junk))
        assert rate_for("text", "openai", SOURCED, model="gpt-5-pro") == (
            RATES["text"]["openai"],
            False,
        )

    def test_a_projection_is_still_a_projection_without_the_extra(self, no_litellm: None) -> None:
        cost = project("text", "openai", {"max_tokens": 100}, SOURCED, model="gpt-5-pro")
        assert cost.unpriced is False
        assert cost.units > 0


class TestAgainstTheRealLibrary:
    """Skipped when the extra is not installed — the same rule an absent sibling area gets."""

    @pytest.fixture(autouse=True)
    def _require_litellm(self) -> None:
        pytest.importorskip("litellm", reason="the [litellm] extra is not installed")

    def test_the_shipped_default_models_are_priced_by_the_real_map(self) -> None:
        """The keys agora looks up are keys the real map actually carries."""
        for provider, model in (("anthropic", "claude-sonnet-4-5"), ("openai", "gpt-4o-mini")):
            assert usd_rate_for("text", provider, model, SOURCED) is not None

    def test_the_real_map_loads_without_reaching_the_network(self) -> None:
        """LiteLLM refreshes its map over HTTP at import unless told to use the bundled one."""
        litellm_prices._price_map()
        import os

        assert os.environ[LOCAL_MAP_ENV] == "True"
