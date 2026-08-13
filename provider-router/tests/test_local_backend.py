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
all — is in ``test_litellm_dispatch.py``, where the stand-in library lives.

The other two thirds of the posture are here too, because they are the same subject: where
an unauthenticated local server is expected to be bound (and what the router says when it is
not), and the credential it carries for one that is authenticated. All three are
``docs/local-backend-posture.md``.
"""

from __future__ import annotations

import json

import pytest
from pydantic import SecretStr

from agora_provider_router.backends import (
    LOCAL_PROVIDER,
    LOCAL_PROVIDERS,
    MLX_PROVIDER,
    Backend,
    UnconfiguredLocalAddress,
    dispatch_headers,
    dispatch_url,
    local_bind,
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

#: tier → the namespaced credential var. There is no non-namespaced fallback spelling: a
#: local server's key is nobody's convention but this router's.
API_KEY_VARS: dict[str, str] = {
    "local": "AGORA_PROVIDER_OLLAMA_API_KEY",
    "mlx": "AGORA_PROVIDER_MLX_SERVE_API_KEY",
}

#: A loopback address per tier — the *expected* deployment, since an unauthenticated local
#: server is safe by where it is bound and by nothing else.
LOOPBACK: dict[str, str] = {
    "local": "http://127.0.0.1:11434/v1",
    "mlx": "http://localhost:8080/v1",
}


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


class TestTheBindPostureIsClassifiedNotAssumed:
    """Where an unauthenticated local server is expected to be, and what is said when it is not.

    The router does not *enforce* loopback — an operator running a model server on another
    box on their network has a real deployment, and refusing it would be this commons
    deciding somebody's topology. It classifies and reports instead, so that the remote case
    is an explicit choice rather than one indistinguishable from the safe one.
    """

    @pytest.mark.parametrize(
        "base_url",
        [
            "http://127.0.0.1:11434/v1",
            "http://127.0.0.1:11434",
            "http://localhost:8080/v1",
            "HTTP://LocalHost:8080/v1",
            "http://[::1]:11434/v1",
            "http://127.5.6.7/v1",
            "http://ollama.localhost:11434/v1",
            # A bare ``host:port`` is how ``OLLAMA_HOST`` is spelled in the wild, and it is
            # not a URL scheme however much it parses as one.
            "localhost:11434",
            "127.0.0.1:11434",
        ],
    )
    def test_loopback_addresses_are_recognised(self, base_url: str) -> None:
        assert local_bind(base_url) == "loopback"

    @pytest.mark.parametrize(
        "base_url",
        [
            "http://ollama.test:11434/v1",
            "http://10.0.0.4:11434/v1",
            "http://0.0.0.0:11434/v1",
            "https://ollama.internal.example/v1",
            "http://[2001:db8::1]:11434/v1",
            "http://localhost.example.com:11434/v1",
            # Not demonstrably loopback is remote: an unparseable host is the operator's to
            # explain, and "I could not tell" must not read as "it stays on the box".
            "://:::",
            "ollama.test:11434",
            "   ",
        ],
    )
    def test_anything_not_demonstrably_loopback_is_remote(self, base_url: str) -> None:
        assert local_bind(base_url) == "remote"

    @pytest.mark.parametrize("base_url", [None, ""])
    def test_no_address_is_nothing_to_classify(self, base_url: str | None) -> None:
        """Nothing to classify on exactly the values ``dispatch_url`` calls no address, so a
        rung that will be dialed always reports where it is being dialed."""
        assert local_bind(base_url) is None
        addressless = Backend(tier="local", provider=LOCAL_PROVIDER, modality="text", model="m")
        assert addressless.bind is None

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_a_loopback_rung_is_ready_and_says_nothing_further(self, tier: str) -> None:
        resolution = resolve_tier(tier, "text", config_for(**{BASE_URL_VARS[tier]: LOOPBACK[tier]}))
        assert resolution.status == "ready"
        assert resolution.reason is None
        assert resolution.backend is not None and resolution.backend.bind == "loopback"
        assert resolution.describe()["bind"] == "loopback"

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_a_remote_rung_is_ready_but_marked(self, tier: str) -> None:
        """Allowed, because configured; never silent, because it was designed for loopback."""
        resolution = resolve_tier(tier, "text", config_for(**configured(tier)))
        assert resolution.status == "ready"
        assert resolution.reason is not None
        assert "non-loopback" in resolution.reason and ADDRESSES[tier] in resolution.reason
        assert "explicit operator choice" in resolution.reason
        assert resolution.backend is not None and resolution.backend.bind == "remote"
        assert resolution.describe()["bind"] == "remote"

    def test_the_two_are_distinguishable_on_doctor(self) -> None:
        """The whole point: a report cannot show the two deployments as the same thing."""
        remote = router_for(**configured("local")).doctor()["text"]
        loopback = router_for(OLLAMA_BASE_URL=LOOPBACK["local"]).doctor()["text"]
        assert remote["resolves_to"]["bind"] == "remote"
        assert loopback["resolves_to"]["bind"] == "loopback"
        assert "non-loopback" in json.dumps(remote)
        assert "non-loopback" not in json.dumps(loopback)

    def test_only_a_local_rung_describes_a_bind(self) -> None:
        """A paid vendor's address is public vocabulary, not a claim about anyone's network."""
        paid = Backend(
            tier="paid",
            provider="openai",
            modality="text",
            model="gpt-4o-mini",
            base_url="https://api.openai.com/v1",
        )
        assert paid.bind is None
        assert "bind" not in paid.describe()
        assert "bind" not in resolve_tier("paid", "text", config_for(OPENAI_API_KEY="k")).describe()


class TestAuthIsOptionalCarriedAndNeverFabricated:
    """The local tiers are keyless by *default*, not by rule."""

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_a_configured_credential_reaches_the_backend_and_the_headers(self, tier: str) -> None:
        env = configured(tier, **{API_KEY_VARS[tier]: "local-proxy-token"})
        backend = resolve_tier(tier, "text", config_for(**env)).backend
        assert backend is not None and backend.api_key is not None
        assert backend.api_key.get_secret_value() == "local-proxy-token"
        assert dispatch_headers(backend)["authorization"] == "Bearer local-proxy-token"

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_no_credential_means_no_header_at_all(self, tier: str) -> None:
        """Not an empty bearer — a permissive backend would take it and a strict one would
        reject it for a reason that has nothing to do with the operator's configuration."""
        backend = resolve_tier(tier, "text", config_for(**configured(tier))).backend
        assert backend is not None and backend.api_key is None
        assert dispatch_headers(backend) == {"content-type": "application/json"}

    def test_an_empty_credential_is_no_credential(self) -> None:
        backend = Backend(
            tier="local", provider=LOCAL_PROVIDER, modality="text", model="m", api_key=SecretStr("")
        )
        assert "authorization" not in dispatch_headers(backend)

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_a_credential_is_not_an_address(self, tier: str) -> None:
        """Rule 1 is untouched by rule 3: a key alone still buys no rung."""
        resolution = resolve_tier(tier, "text", config_for(**{API_KEY_VARS[tier]: "k"}))
        assert resolution.status == "unconfigured"
        assert resolution.backend is None

    def test_a_local_credential_is_never_reported(self) -> None:
        """``SecretStr`` all the way down: ``/doctor`` says a key is set, never which."""
        env = configured("local", **{API_KEY_VARS["local"]: "local-proxy-token"})
        router = router_for(**env)
        assert "local-proxy-token" not in json.dumps(router.doctor())
        assert "local-proxy-token" not in json.dumps(router.config.describe())

    def test_the_paid_tier_is_dialed_by_the_same_rule(self) -> None:
        """One decision point for every tier, so neither can drift from the other."""
        backend = resolve_tier("paid", "text", config_for(OPENAI_API_KEY="sk-test")).backend
        assert backend is not None
        assert dispatch_headers(backend) == {
            "content-type": "application/json",
            "authorization": "Bearer sk-test",
        }
