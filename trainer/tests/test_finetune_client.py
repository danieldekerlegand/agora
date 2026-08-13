"""The four-verb dance, end to end against the live endpoints — no stub anywhere (agora:50 US-3).

This is the **agora-side stand-in** for the orchestrator's production `finetune` client. That
client is another repo's work by decision (ADR-0001: agora publishes the capability, whoever runs
the control plane writes the caller), and it exists —
*attributed cross-repo reference, history rather than something agora knows*:
`cuneiform:90-finetune-client` (merged; its `Runner::Kcb` replaced the stub runner), which at
deploy time drives this same dance against a participant's **specialized** provider
(`lugh:30-kft-provider-manifest`) *and* this general trainer, with the discovery registry
disambiguating the two (KFT §9/FT-K, `registry/src/select.ts`). Nothing in `src/` names either.

What this suite is for: the §6 stream (US-1), the §5.3 export matrix and the §8 registration
(US-2) are only *live* if a caller that knows nothing but one address can reach them. So
:mod:`finetune_client` starts at the A2A agent card, reads every subsequent address out of the
manifest, carries an `invoke:finetune` grant with a §7 ceiling, watches the run from before it
exists, and collects what it minted. Every assertion below is against the running app.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_trainer import TRAINER_IDENTITY
from agora_trainer.app import BUDGET_HEADER, app, get_config, get_registrations, get_runs
from agora_trainer.cost import METER
from agora_trainer.journal import RunRegistry
from agora_trainer.manifest import AGENT_CARD_PATH, EXPORTS_PATH, INVOKE_PATH, SUBSCRIBE_PATH
from agora_trainer.registration import Registrations
from conftest import config_for, exhaust_job, valid_text_job
from finetune_client import (
    GRANT_VERB,
    DialFailed,
    FinetuneClient,
    GrantToken,
    Undiscoverable,
)

#: The address the manifest advertises here — TestClient's own host, so the client dials the
#: *published absolute URLs* rather than paths it invented. Discovery is the point.
BASE_URL = "http://testserver"

#: The world the grant is scoped to (KCB §5, grants are per-world) — sample data.
WORLD = "orchestrator:world:demo"

#: A ceiling that admits the sample jobs, and one that cannot admit anything (FT-E).
AMPLE_UNITS = 100_000.0
STARVED_UNITS = 1.0

EXPORTABLE_JOB = "orchestrator:activity:ft-run/9f2a"  # `valid_text_job` — an exportable corpus
LOCAL_ONLY_JOB = "orchestrator:activity:ft-run/e9d7"  # `exhaust_job` — a local-only exhaust


@pytest.fixture(autouse=True)
def provider() -> Any:
    """The trainer, fresh per test, publishing itself at the address the client dials."""
    config = config_for(AGORA_TRAINER_PUBLIC_BASE_URL=BASE_URL)
    # One registry and one ledger for the whole test: the provider's process state is shared
    # across its verbs, which is exactly what makes a run subscribable from another connection.
    runs, registrations = RunRegistry(), Registrations()
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_runs] = lambda: runs
    app.dependency_overrides[get_registrations] = lambda: registrations
    yield config
    for provide in (get_config, get_runs, get_registrations):
        app.dependency_overrides.pop(provide, None)


@pytest.fixture
def grant() -> GrantToken:
    return GrantToken(world=WORLD, budget_units=AMPLE_UNITS)


@pytest.fixture
def client(grant: GrantToken) -> FinetuneClient:
    """A client holding one address and one grant — everything else is discovered."""
    return FinetuneClient(
        lambda: TestClient(app), card_url=f"{BASE_URL}{AGENT_CARD_PATH}", grant=grant
    )


class TestDiscovery:
    def test_the_agent_card_alone_reaches_the_capabilitys_own_endpoint(
        self, client: FinetuneClient
    ) -> None:
        """KCB §3: card → manifest → the capability that accepts this modality, and its address."""
        found = client.discover("text-generation")
        assert found.identity == TRAINER_IDENTITY
        assert found.invoke == f"{BASE_URL}{INVOKE_PATH}"
        assert found.subscribe == f"{BASE_URL}{SUBSCRIBE_PATH}"
        assert found.exports == f"{BASE_URL}{EXPORTS_PATH}"
        assert GRANT_VERB in found.grants_required
        assert found.meter == METER
        assert found.est_units > 0  # the nominal §2 figure a caller sizes a grant against

    def test_each_modality_resolves_to_the_capability_that_accepts_it(
        self, client: FinetuneClient
    ) -> None:
        """One `finetune` capability per modality (KFT §2) — path search picks, not the client."""
        assert client.discover("text-to-video").modality == "text-to-video"

    def test_a_modality_no_capability_accepts_is_undiscoverable(
        self, client: FinetuneClient
    ) -> None:
        with pytest.raises(Undiscoverable, match="text-to-hologram"):
            client.discover("text-to-hologram")

    def test_a_grant_the_provider_does_not_require_is_undiscoverable(self) -> None:
        """A client holding the wrong capability's grant learns it at discovery, not at invoke."""
        elsewhere = FinetuneClient(
            lambda: TestClient(app),
            card_url=f"{BASE_URL}{AGENT_CARD_PATH}",
            grant=GrantToken(world=WORLD, verb="invoke:compose"),
        )
        with pytest.raises(Undiscoverable, match="invoke:compose"):
            elsewhere.discover("text-generation")


class TestTheDance:
    def test_discover_invoke_subscribe_and_collect_run_end_to_end(
        self, client: FinetuneClient
    ) -> None:
        run = client.finetune(valid_text_job(), across_boundary=False)
        assert run.provider.identity == TRAINER_IDENTITY
        assert run.terminal["terminal"] is True
        assert run.model.startswith("agora:model:ft-")
        assert run.terminal["weights"]
        assert run.exports is not None and run.exports["exports"]
        assert run.registration is not None
        assert run.registration["registration"]["model"] == run.model

    def test_the_subscriber_was_watching_before_the_run_existed(
        self, client: FinetuneClient
    ) -> None:
        """The orchestrator's ordering: mint a job id, watch it, then dispatch it (KFT §6).

        The first attempt necessarily meets the provider's honest `unknown-run` 404 — the run is
        opened by the `invoke` the client only issues once its watcher is in flight — so an
        attached subscription proves the retry, and proves the stream is addressable by job.
        """
        run = client.finetune(valid_text_job(), collect=False)
        assert run.watched.attempts >= 2
        assert run.watched.terminal is not None

    def test_both_connections_read_one_identical_ordered_stream(
        self, client: FinetuneClient
    ) -> None:
        """The subscriber is not the connection that opened the run, and reads the same §6."""
        run = client.finetune(valid_text_job(), collect=False)
        assert run.watched.events == run.invoked
        assert list(run.watched.steps) == sorted(run.watched.steps)  # monotonic
        assert len(set(run.watched.ids)) == len(run.watched.ids)  # content-addressed, unique

    def test_a_watcher_that_reconnects_at_a_cursor_redelivers_identical_events(
        self, client: FinetuneClient
    ) -> None:
        """A dropped subscription resumes without an exactly-once transport (KFT §6, KCB §4)."""
        run = client.finetune(valid_text_job(), collect=False)
        cursor = run.watched.steps[2]
        resumed = client.subscribe(run.provider, EXPORTABLE_JOB, from_step=cursor)
        assert resumed.events == run.watched.events[2:]
        assert resumed.terminal == run.watched.terminal

    def test_the_collected_matrix_is_the_lineage_the_run_minted(
        self, client: FinetuneClient
    ) -> None:
        """§5.3 over the wire: KMI assets carrying `media:derived_from` / `media:variant_of`."""
        run = client.finetune(valid_text_job())
        assert run.exports is not None
        assert run.exports["model"]["id"] == run.model
        relations = {
            link["relation"] for export in run.exports["exports"] for link in export["lineage"]
        }
        # The matrix *is* the KMI lineage graph — adapter → base, each export → the adapter.
        assert relations == {"media:derived_from", "media:variant_of"}
        assert [export["id"] for export in run.exports["exports"]] == list(run.terminal["weights"])

    def test_registering_the_same_run_twice_is_idempotent(self, client: FinetuneClient) -> None:
        run = client.finetune(valid_text_job(), across_boundary=False)
        again = client.register(run.provider, EXPORTABLE_JOB, across_boundary=False)
        assert run.registration is not None
        assert again["registration"] == run.registration["registration"]


class TestTheGrant:
    def test_the_token_carries_the_invoke_finetune_claims_and_its_ceiling(
        self, grant: GrantToken
    ) -> None:
        """KCB §5 shape: per-capability verb, per-world scope, a `budget_units` ceiling (§7)."""
        claims = GrantToken.claims_of(grant.headers()["Authorization"].removeprefix("Bearer "))
        assert claims == {
            "verb": GRANT_VERB,
            "world": WORLD,
            "budget_units": AMPLE_UNITS,
            "meter": METER,
        }

    def test_the_ceiling_rides_the_budget_header_on_the_verb_that_spends(
        self, grant: GrantToken
    ) -> None:
        assert grant.headers()[BUDGET_HEADER] == str(AMPLE_UNITS)
        assert BUDGET_HEADER not in grant.headers(ceiling=False)  # reads spend nothing
        assert BUDGET_HEADER not in GrantToken(world=WORLD).headers()  # ungated grant

    def test_a_starved_ceiling_is_refused_before_the_run_starts(self) -> None:
        """FT-E: the resolved per-job estimate is checked against the grant, not the manifest."""
        starved = FinetuneClient(
            lambda: TestClient(app),
            card_url=f"{BASE_URL}{AGENT_CARD_PATH}",
            grant=GrantToken(world=WORLD, budget_units=STARVED_UNITS),
        )
        with pytest.raises(DialFailed) as refusal:
            starved.finetune(valid_text_job())
        assert refusal.value.verb == "invoke"
        assert refusal.value.status == 422
        assert "budget" in refusal.value.codes

    def test_a_refused_job_leaves_no_run_for_the_watcher_to_attach_to(
        self, client: FinetuneClient
    ) -> None:
        """Admission runs before the journal exists, so the watcher is released, not stranded."""
        job = valid_text_job()
        del job["base_model"]
        with pytest.raises(DialFailed) as refusal:
            client.finetune(job)
        assert refusal.value.status == 422
        provider = client.discover("text-generation")
        with pytest.raises(DialFailed) as gave_up:
            client.subscribe(provider, EXPORTABLE_JOB, timeout=0.0)
        assert gave_up.value.codes == ("unknown-run",)


class TestOutputEgress:
    def test_a_local_only_model_is_refused_a_cross_boundary_registration(
        self, client: FinetuneClient
    ) -> None:
        """§5.4/FT-A over the wire: the client is told which gate refused, not handed a 500."""
        with pytest.raises(DialFailed) as refusal:
            client.finetune(exhaust_job(), across_boundary=True)
        assert refusal.value.verb == "register"
        assert refusal.value.status == 422
        assert "egress-output" in refusal.value.codes

    def test_the_same_model_registers_in_tier(self, client: FinetuneClient) -> None:
        """Keeping `local-only` output in-tier is exactly what §5.4 permits."""
        run = client.finetune(exhaust_job(), across_boundary=False)
        assert run.registration is not None
        entry = run.registration["registration"]
        assert entry["across_boundary"] is False
        assert entry["model"] == run.model
        assert run.watched.events == run.invoked  # the dance is identical for a local-only run
