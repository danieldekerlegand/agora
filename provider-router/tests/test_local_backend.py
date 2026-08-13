"""The local tier's address is the operator's — never a library's default.

The rung exists **if and only if** a base URL was configured. That is the whole rule, and
it is stated twice on purpose: once at resolution (an unconfigured local tier is
``unconfigured``, so no backend is ever built for it) and once at dispatch
(:func:`~agora_provider_router.backends.dispatch_url`, so no transport layered under this
router can substitute an address on its way out). LiteLLM defaults ``ollama`` to
``http://localhost:11434`` and it is not alone; inheriting any such default would make "no
local server configured" a claim about whatever happens to be listening on the box, which
is precisely the state the zero-spend invariant has to be able to assert.

The LiteLLM half of the same rule — that a local rung never reaches the borrowed adapter at
all — is in ``test_litellm_dispatch.py``, where the stand-in library lives. See
``docs/spike-litellm-leaf.md`` §N2/N3.
"""

from __future__ import annotations

import json

import pytest

from agora_provider_router.backends import (
    LOCAL_PROVIDER,
    LOCAL_PROVIDERS,
    MLX_PROVIDER,
    Backend,
    UnconfiguredLocalAddress,
    dispatch_url,
    resolve_tier,
)
from agora_provider_router.ladder import LOCAL_TIERS, PLACEHOLDER
from agora_provider_router.router import Router, http_transport
from conftest import config_for, recording_transport, router_for, run

#: What client libraries default the local provider to. It appears in this file, in the
#: docs, and nowhere in the package — which is the assertion, not an accident.
LIBRARY_DEFAULT = "http://localhost:11434"

#: The addresses these tests configure. Deliberately not loopback-looking, so a test that
#: passed by accident of something listening locally would be visible as such.
ADDRESSES: dict[str, str] = {
    "local": "http://ollama.test:11434/v1",
    "mlx": "http://mlx.test:8080/v1",
}

#: tier → the env var that gives it an address, in its non-namespaced spelling.
BASE_URL_VARS: dict[str, str] = {"local": "OLLAMA_BASE_URL", "mlx": "MLX_SERVE_BASE_URL"}


def configured(tier: str, **env: str) -> dict[str, str]:
    return {BASE_URL_VARS[tier]: ADDRESSES[tier], **env}


class TestARungExistsOnlyByConfiguration:
    """Resolution: the native (non-LiteLLM) path, which is the only one by default."""

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_no_configured_address_is_no_rung(self, tier: str) -> None:
        resolution = resolve_tier(tier, "text", config_for())
        assert resolution.status == "unconfigured"
        assert resolution.backend is None
        assert resolution.reason is not None and "base URL not set" in resolution.reason

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_a_configured_address_is_the_one_that_resolves(self, tier: str) -> None:
        backend = resolve_tier(tier, "text", config_for(**configured(tier))).backend
        assert backend is not None
        assert backend.provider in LOCAL_PROVIDERS
        assert backend.base_url == ADDRESSES[tier]
        assert backend.url == f"{ADDRESSES[tier]}/chat/completions"

    def test_the_ollama_host_spelling_configures_it_too(self) -> None:
        """``OLLAMA_HOST`` is a fallback spelling, not a fallback *value*."""
        backend = resolve_tier("local", "text", config_for(OLLAMA_HOST=ADDRESSES["local"])).backend
        assert backend is not None and backend.base_url == ADDRESSES["local"]
        assert resolve_tier("local", "text", config_for(OLLAMA_HOST="")).status == "unconfigured"

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_an_explicitly_disabled_local_provider_is_no_rung_either(self, tier: str) -> None:
        provider = (LOCAL_PROVIDER if tier == "local" else MLX_PROVIDER).upper().replace("-", "_")
        env = configured(tier, **{f"AGORA_PROVIDER_{provider}_ENABLED": "0"})
        assert resolve_tier(tier, "text", config_for(**env)).status == "unconfigured"

    def test_a_bare_router_reports_no_local_address_at_all(self) -> None:
        """``/doctor`` on a keyless, serverless box: every rung it names is one it was given."""
        report = json.dumps(router_for().doctor())
        assert LIBRARY_DEFAULT not in report
        assert "11434" not in report and "localhost" not in report
        assert [b.tier for b in router_for().candidates("text")] == [PLACEHOLDER]


class TestNoTransportSubstitutesADefault:
    """Dispatch: the same rule where a library would otherwise fill the gap in."""

    @pytest.mark.parametrize("provider", sorted(LOCAL_PROVIDERS))
    def test_a_local_backend_without_an_address_is_refused_not_dialed(self, provider: str) -> None:
        backend = Backend(tier="local", provider=provider, modality="text", model="m")
        with pytest.raises(UnconfiguredLocalAddress, match="never dialed at a default address"):
            dispatch_url(backend)
        with pytest.raises(UnconfiguredLocalAddress):
            run(http_transport(backend, {}))

    def test_the_configured_address_is_what_is_dialed(self) -> None:
        backend = Backend(
            tier="local",
            provider=LOCAL_PROVIDER,
            modality="text",
            model="llama3.2",
            base_url=ADDRESSES["local"],
        )
        assert dispatch_url(backend) == f"{ADDRESSES['local']}/chat/completions"

    def test_a_paid_rung_may_still_carry_no_address_of_its_own(self) -> None:
        """A borrowed adapter knows the vendor's address; a vendor address is public."""
        native = Backend(tier="paid", provider="anthropic", modality="text", model="claude")
        assert dispatch_url(native) == "/chat/completions"

    def test_an_unconfigured_local_tier_reaches_no_transport_at_all(self) -> None:
        """End to end: absent, not dialed — the real transport is never even entered."""
        dialed: list[Backend] = []
        router = Router(config_for(AGORA_TEXT_LADDER="local"), recording_transport(dialed))
        completion = run(router.complete("text", {"messages": []}))
        assert completion.tier == PLACEHOLDER
        assert dialed == []
        assert [(a.tier, a.dialed) for a in completion.attempts] == [
            ("local", False),
            (PLACEHOLDER, True),
        ]
