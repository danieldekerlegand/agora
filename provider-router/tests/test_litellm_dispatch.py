"""The optional LiteLLM dispatch adapter — what it may add, and what it may never move.

Two halves. The first is the *addition*: with ``AGORA_LITELLM=1`` a native-wire vendor
LiteLLM covers stops being ``pending-adapter`` and becomes a dialable paid rung. The second
is the *invariant*, and it is the load-bearing one — enabling a vendor adapter must not
change the ladder, the pre-dial ceiling, or the terminal placeholder. A borrowed adapter is a
transport; the guarantees live above it.

LiteLLM is an optional extra, so the adapter's translation is exercised against a stand-in
module injected into ``sys.modules``. That is not a weaker test than the real library for
what is under test here: what matters is which arguments agora hands over and, far more
importantly, **how many times it hands anything over at all**. ``TestTheCeilingStillRefuses``
counts the calls, exactly as the spike's experiment 8 did. The real library is exercised
separately by :class:`TestAgainstTheRealLibrary`, which skips when the extra is absent — the
same rule the conformance suites give an absent sibling area.
"""

from __future__ import annotations

import importlib
import sys
import tomllib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_provider_router import litellm_dispatch
from agora_provider_router.app import app, get_router
from agora_provider_router.backends import (
    LOCAL_PROVIDER,
    LOCAL_PROVIDERS,
    PAID_PROVIDERS,
    PAID_VENDORS,
    Backend,
    TierResolution,
    resolve_tier,
)
from agora_provider_router.cost import BUDGET_HEADER, BUDGET_KEY, project
from agora_provider_router.ladder import MODALITIES, PLACEHOLDER
from agora_provider_router.litellm_dispatch import (
    CALLS,
    ENABLE_ENV,
    NATIVE_ADAPTERS,
    Adapter,
)
from agora_provider_router.router import Router, default_transport, http_transport
from conftest import config_for, recording_transport, run

#: An Anthropic key plus the adapter switched on: the whole configuration a deployer needs.
BORROWED: dict[str, str] = {"ANTHROPIC_API_KEY": "sk-ant-test", ENABLE_ENV: "1"}

#: An address for the local rung. Not loopback-looking on purpose: a test that passed
#: because something was listening on the box would be exactly the bug under test.
OLLAMA = "http://ollama.test:11434/v1"

#: 1000 tokens of text — expensive enough on the paid tier for a ceiling to bite.
PROMPT: dict[str, Any] = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 1000}

#: What that costs on Anthropic, stated relatively so a corrected rate does not break a test.
ANTHROPIC_UNITS = project("text", "anthropic", PROMPT).units


class Dumpable:
    """Stands in for a LiteLLM ``ModelResponse``: a pydantic model, not a dict."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    def model_dump(self) -> dict[str, Any]:
        return dict(self._body)


class FakeLiteLLM:
    """A ``litellm`` module that records every call instead of making one."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.response: Any = Dumpable({"id": "borrowed"})

    async def acompletion(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.response


@pytest.fixture
def fake_litellm(monkeypatch: pytest.MonkeyPatch) -> FakeLiteLLM:
    """Install a stand-in ``litellm`` for the duration of one test."""
    fake = FakeLiteLLM()
    monkeypatch.setitem(sys.modules, "litellm", fake)
    return fake


def paid(modality: str, **env: str) -> TierResolution:
    """The paid rung ``modality`` resolves to under ``env``."""
    return resolve_tier("paid", modality, config_for(**env))


class TestOffByDefault:
    """The default surface must be exactly what it was — the Erlang router has no LiteLLM."""

    def test_a_native_vendor_stays_pending_without_the_variable(self) -> None:
        resolution = paid("text", ANTHROPIC_API_KEY="sk-ant-test")
        assert resolution.status == "pending-adapter"
        assert resolution.backend is None
        assert resolution.reason is not None and "anthropic" in resolution.reason

    def test_the_default_transport_is_a_plain_post(self) -> None:
        assert default_transport(config_for(ANTHROPIC_API_KEY="sk-ant-test")) is http_transport

    def test_an_unset_or_false_variable_is_off(self) -> None:
        for off in ("", "0", "no", "off", "maybe"):
            assert not litellm_dispatch.enabled({ENABLE_ENV: off})
        for on in ("1", "true", "YES", "on"):
            assert litellm_dispatch.enabled({ENABLE_ENV: on})


class TestBorrowedAdapters:
    def test_a_covered_native_vendor_becomes_a_dialable_paid_rung(self) -> None:
        resolution = paid("text", **BORROWED)
        assert resolution.status == "ready"
        assert resolution.backend is not None
        assert resolution.backend.provider == "anthropic"
        assert resolution.backend.model == "claude-sonnet-4-5"

    def test_the_declared_vendor_order_still_stands_above_it(self) -> None:
        resolution = paid("text", OPENAI_API_KEY="sk-test", **BORROWED)
        assert resolution.backend is not None
        assert resolution.backend.provider == "openai", "a borrowed adapter does not reorder"

    def test_a_configured_model_overrides_the_default(self) -> None:
        resolution = paid("text", AGORA_PROVIDER_ANTHROPIC_MODEL="claude-haiku-4-5", **BORROWED)
        assert resolution.backend is not None
        assert resolution.backend.model == "claude-haiku-4-5"

    @pytest.mark.parametrize(
        ("modality", "key_var"),
        [
            ("speech", "ELEVENLABS_API_KEY"),  # litellm's aspeech answers with a binary stream
            ("image", "REPLICATE_API_TOKEN"),  # litellm prices replicate for chat, not image
            ("video", "RUNWAY_API_KEY"),  # no litellm adapter at all
        ],
    )
    def test_an_uncovered_vendor_is_still_an_honest_refusal(
        self, modality: str, key_var: str
    ) -> None:
        """A gap is recorded, never forced: no adapter beats a guessed one."""
        resolution = paid(modality, **{key_var: "k", ENABLE_ENV: "1"})
        assert resolution.status == "pending-adapter"
        assert resolution.backend is None

    def test_every_declared_adapter_is_one_agora_actually_routes(self) -> None:
        """The table cannot claim a vendor/modality pair the rest of the router disagrees on."""
        for name, adapter in NATIVE_ADAPTERS.items():
            assert PAID_VENDORS[name].wire == "native", f"{name} needs no borrowed adapter"
            assert adapter.modalities, f"{name} declares no modality"
            for modality in adapter.modalities:
                assert modality in MODALITIES
                assert modality in CALLS, f"no litellm surface for {modality}"
                assert name in PAID_PROVIDERS[modality], f"agora does not route {name} for it"
                assert (PAID_VENDORS[name].models or {}).get(modality), "no default model"


class TestTranslation:
    def test_a_native_rung_is_dialed_through_litellm(self, fake_litellm: FakeLiteLLM) -> None:
        router = Router(config_for(**BORROWED))
        completion = run(router.complete("text", dict(PROMPT)))

        assert completion.tier == "paid"
        assert completion.backend.provider == "anthropic"
        assert completion.response == {"id": "borrowed"}, "the response object is dumped"
        (call,) = fake_litellm.calls
        assert call["model"] == "anthropic/claude-sonnet-4-5"
        assert call["api_key"] == "sk-ant-test"
        assert call["messages"] == PROMPT["messages"]
        assert call["drop_params"] is True
        assert "api_base" not in call, "litellm owns the vendor's own address"

    def test_the_backend_model_wins_over_the_body(self, fake_litellm: FakeLiteLLM) -> None:
        """LiteLLM routes on a provider-qualified id a caller's ``model`` cannot spell."""
        router = Router(config_for(**BORROWED))
        run(router.complete("text", {**PROMPT, "model": "gpt-4o"}))
        assert fake_litellm.calls[0]["model"] == "anthropic/claude-sonnet-4-5"

    def test_an_explicit_base_url_is_passed_through(self, fake_litellm: FakeLiteLLM) -> None:
        env = {"AGORA_PROVIDER_ANTHROPIC_BASE_URL": "http://gw.test", **BORROWED}
        run(Router(config_for(**env)).complete("text", dict(PROMPT)))
        assert fake_litellm.calls[0]["api_base"] == "http://gw.test"

    def test_the_cost_report_reads_the_borrowed_response(self, fake_litellm: FakeLiteLLM) -> None:
        """Either transport produces the same body, so ``settle`` cannot tell them apart."""
        fake_litellm.response = Dumpable({"id": "x", "usage": {"total_tokens": 10}})
        completion = run(Router(config_for(**BORROWED)).complete("text", dict(PROMPT)))
        assert completion.actual.estimate is False
        assert completion.actual.quantity == 10.0

    def test_an_openai_wire_rung_never_reaches_litellm(self, fake_litellm: FakeLiteLLM) -> None:
        """mlx-serve and the OpenAI-shaped vendors are one POST already."""
        calls: list[Backend] = []

        async def fallback(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
            calls.append(backend)
            return {"id": "direct"}

        transport = litellm_dispatch.transport(fallback, timeout=1.0)
        mlx = Backend(tier="mlx", provider="mlx-serve", modality="text", model="qwen")
        assert run(transport(mlx, {})) == {"id": "direct"}
        assert [c.provider for c in calls] == ["mlx-serve"]
        assert fake_litellm.calls == []

    def test_an_undecodable_response_costs_the_rung_not_the_request(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        fake_litellm.response = object()
        completion = run(Router(config_for(**BORROWED)).complete("text", dict(PROMPT)))
        assert completion.tier == PLACEHOLDER
        refused = next(a for a in completion.attempts if a.tier == "paid")
        assert refused.reason is not None and "TypeError" in refused.reason


class TestTheLocalRungIsNeverTheLibrarys:
    """The local tiers keep their own address — the half of the rule this module holds.

    LiteLLM defaults ``ollama`` to ``http://localhost:11434``. Borrowing an adapter must not
    borrow that: a rung dialed there would exist because of what is listening on the box
    rather than because an operator configured it. The resolution half of the same rule —
    no configured base URL, no rung — is in ``test_local_backend.py``.
    """

    def test_a_configured_local_rung_takes_the_direct_post_at_its_own_address(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        dialed: list[Backend] = []
        transport = litellm_dispatch.transport(recording_transport(dialed), timeout=1.0)
        config = config_for(OLLAMA_BASE_URL=OLLAMA, AGORA_TEXT_LADDER="local", **BORROWED)
        completion = run(Router(config, transport).complete("text", dict(PROMPT)))

        assert completion.tier == "local"
        assert [(b.provider, b.base_url) for b in dialed] == [(LOCAL_PROVIDER, OLLAMA)]
        assert dialed[0].url == f"{OLLAMA}/chat/completions"
        assert fake_litellm.calls == [], "the local tier is never the library's to address"

    def test_an_unconfigured_local_rung_is_absent_here_too(self, fake_litellm: FakeLiteLLM) -> None:
        """Adapter on, no address: nothing is dialed, by either transport."""
        dialed: list[Backend] = []
        transport = litellm_dispatch.transport(recording_transport(dialed), timeout=1.0)
        config = config_for(AGORA_TEXT_LADDER="local", **BORROWED)
        completion = run(Router(config, transport).complete("text", dict(PROMPT)))

        assert completion.tier == PLACEHOLDER
        assert dialed == []
        assert fake_litellm.calls == []

    def test_the_adapter_table_claims_no_local_provider(self) -> None:
        assert not NATIVE_ADAPTERS.keys() & LOCAL_PROVIDERS

    def test_and_could_not_route_one_through_the_library_even_if_it_did(
        self, fake_litellm: FakeLiteLLM, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The tier is checked before the table, so the library default stays unreachable."""
        monkeypatch.setitem(NATIVE_ADAPTERS, LOCAL_PROVIDER, Adapter(LOCAL_PROVIDER, ("text",)))
        dialed: list[Backend] = []
        transport = litellm_dispatch.transport(recording_transport(dialed), timeout=1.0)
        backend = Backend(
            tier="local",
            provider=LOCAL_PROVIDER,
            modality="text",
            model="llama3.2",
            base_url=OLLAMA,
        )
        assert run(transport(backend, {})) == {"id": f"{LOCAL_PROVIDER}-response"}
        assert [b.provider for b in dialed] == [LOCAL_PROVIDER]
        assert fake_litellm.calls == []


class TestTheCeilingStillRefuses:
    """The differentiator the spike found NOT COVERED, asserted over the borrowed adapter.

    Counting calls is the only honest proof of a *pre-dial* refusal: "it lost the race" is a
    different guarantee from "it was never contacted", and only the second one cannot spend.
    """

    def test_a_zero_ceiling_lands_on_the_placeholder_having_dialed_nothing(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        router = Router(config_for(**BORROWED))
        completion = run(router.complete("text", {**PROMPT, BUDGET_KEY: 0}))
        assert completion.tier == PLACEHOLDER
        assert completion.actual.units == 0.0
        assert fake_litellm.calls == [], "the borrowed vendor was never contacted"
        refused = next(a for a in completion.attempts if a.tier == "paid")
        assert refused.dialed is False

    def test_the_zero_ceiling_header_lands_on_the_placeholder_over_http(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        """End to end, through the OpenAI surface, with the header a stock SDK can set."""
        app.dependency_overrides[get_router] = lambda: Router(config_for(**BORROWED))
        try:
            response = TestClient(app).post(
                "/v1/chat/completions", json=dict(PROMPT), headers={BUDGET_HEADER: "0"}
            )
        finally:
            app.dependency_overrides.clear()

        assert response.status_code == 200
        assert response.headers["X-Agora-Tier"] == PLACEHOLDER
        assert response.headers["X-Agora-Cost-Units"] == "0"
        assert response.json()["agora"]["cost"]["actual_units"] == 0.0
        assert fake_litellm.calls == []

    def test_a_ceiling_falls_through_to_a_cheaper_tier_without_dialing_the_dearer_one(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        """The borrowed rung is over the ceiling; the free one below it answers, unborrowed."""
        dialed: list[Backend] = []
        # The adapter is real and only the direct POST beneath it is stood in for, so the
        # walk still decides between a LiteLLM rung and an httpx one exactly as deployed.
        transport = litellm_dispatch.transport(recording_transport(dialed), timeout=1.0)
        config = config_for(MLX_SERVE_BASE_URL="http://mlx.test:9000/v1", **BORROWED)
        router = Router(config, transport)
        completion = run(router.complete("text", {**PROMPT, BUDGET_KEY: ANTHROPIC_UNITS / 2}))
        assert completion.tier == "mlx", "the only affordable rung served it"
        assert [b.provider for b in dialed] == ["mlx-serve"]
        assert fake_litellm.calls == [], "the borrowed vendor was skipped, not raced"

    def test_a_generous_ceiling_still_reaches_the_borrowed_rung(
        self, fake_litellm: FakeLiteLLM
    ) -> None:
        """The ceiling is a constraint, not a ban — the proof above is not vacuous."""
        router = Router(config_for(**BORROWED))
        completion = run(router.complete("text", {**PROMPT, BUDGET_KEY: ANTHROPIC_UNITS * 2}))
        assert completion.tier == "paid"
        assert len(fake_litellm.calls) == 1


class TestTheExtraIsOptional:
    def test_the_variable_without_the_package_degrades_it_never_denies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An uninstalled optional dependency costs the rung; the request still completes."""
        monkeypatch.setitem(sys.modules, "litellm", None)
        completion = run(Router(config_for(**BORROWED)).complete("text", dict(PROMPT)))
        assert completion.tier == PLACEHOLDER
        refused = next(a for a in completion.attempts if a.tier == "paid")
        assert refused.reason is not None and "pip install" in refused.reason


class TestAgainstTheRealLibrary:
    """Skipped when the extra is not installed — the same rule an absent sibling area gets."""

    @pytest.fixture(autouse=True)
    def _require_litellm(self) -> None:
        pytest.importorskip("litellm", reason="the [litellm] extra is not installed")

    @pytest.mark.parametrize("name", sorted(NATIVE_ADAPTERS))
    def test_every_declared_adapter_resolves_in_litellm(self, name: str) -> None:
        """The prefix and default model this router ships actually route inside LiteLLM."""
        litellm = importlib.import_module("litellm")
        adapter = NATIVE_ADAPTERS[name]
        for modality in adapter.modalities:
            model = (PAID_VENDORS[name].models or {})[modality]
            assert litellm.get_llm_provider(f"{adapter.provider}/{model}")[1] == adapter.provider
            assert hasattr(litellm, CALLS[modality])

    def test_a_real_borrowed_completion_comes_back_openai_shaped(self) -> None:
        """Offline: LiteLLM's own ``mock_response`` answers without a key, a socket or a cent.

        It rides in the request body, so every line under test is the shipped adapter's —
        the model id it builds, the key it attaches, and the response object it decodes.
        """
        router = Router(config_for(**BORROWED))
        completion = run(router.complete("text", {**PROMPT, "mock_response": "borrowed"}))
        assert completion.tier == "paid"
        assert completion.backend.provider == "anthropic"
        assert completion.response["object"] == "chat.completion"
        assert completion.response["choices"][0]["message"]["content"] == "borrowed"
        assert completion.actual.estimate is False, "usage came back off the real response"


#: The two LiteLLM releases backdoored on PyPI in March 2026. An optional dependency that sits
#: on a request hot path may not be installable at a version with a known implant, so the extra's
#: floor is what makes them unresolvable — see `docs/litellm-dispatch-adapter.md` §"Why this stays
#: a Python-side borrow".
BACKDOORED: tuple[tuple[int, ...], ...] = ((1, 82, 7), (1, 82, 8))

#: Where the extra is declared. Read rather than imported: the constraint under test is packaging
#: metadata, and an installed distribution would tell us what a resolver already chose.
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def _release(version: str) -> tuple[int, ...]:
    """``"1.95"`` -> ``(1, 95)``. Enough of PEP 440 to order a floor against a bad release."""
    return tuple(int(part) for part in version.strip().split(".") if part.isdigit())


class TestTheFlooredExtraExcludesTheBackdooredReleases:
    """The supply-chain argument as a check rather than a comment.

    ``>=1.95`` already puts both compromised releases out of reach; what this pins down is that
    the floor stays *deliberate*. Lower it past 1.82.7 for any reason — a bisect, a downstream
    conflict, a copy-paste — and this fails rather than quietly making the implant installable.
    """

    def test_the_extra_is_still_declared(self) -> None:
        extras = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"][
            "optional-dependencies"
        ]
        assert extras["litellm"] == ["litellm>=1.95"], (
            "the [litellm] extra changed shape — re-check the floor against BACKDOORED before "
            "loosening this assertion"
        )

    @pytest.mark.parametrize("bad", BACKDOORED, ids=lambda v: ".".join(str(p) for p in v))
    def test_no_backdoored_release_satisfies_the_constraint(self, bad: tuple[int, ...]) -> None:
        extras = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"][
            "optional-dependencies"
        ]
        requirement = next(r for r in extras["litellm"] if r.startswith("litellm"))
        clauses = [clause.strip() for clause in requirement[len("litellm") :].split(",")]
        floors = [_release(c[2:]) for c in clauses if c.startswith(">=")]
        excluded = {_release(c[2:]) for c in clauses if c.startswith("!=")}
        assert any(floor > bad for floor in floors) or bad in excluded, (
            f"{requirement!r} would let the optional extra resolve to "
            f"{'.'.join(str(p) for p in bad)}, which was backdoored on PyPI in March 2026"
        )
