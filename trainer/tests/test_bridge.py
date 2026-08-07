"""The KFT dataset bridge — admit a producer's exhaust, route it (FT-K), dial the winner.

The end-to-end walk mirrors koine's `e2e-producer-exhaust-finetune` scenario: an application's
recorded runs, serialized as a training-record JSONL, minted as a KMI asset, referenced with its
header copied inline, admitted under the §4 gate, routed to a specialist local provider, and
dialed directly. The bridge is **producer-agnostic** — every test here drives it with a synthetic
producer in a namespace nothing in agora knows about, and nothing in the bridge canonicalizes
anybody's records.
"""

from __future__ import annotations

from typing import Any

from agora_trainer.bridge import (
    Directory,
    Dispatch,
    ProviderOffer,
    Selection,
    offer_from,
    selection_from,
    self_directory,
    submit,
)
from agora_trainer.grant import Grant
from agora_trainer.records import FetchedRecords
from conftest import exhaust_header, exhaust_job

#: The general trainer — cloud-capable, broad surface (KFT §9).
GENERAL = ProviderOffer(
    identity="agora:agent:trainer",
    address="http://127.0.0.1:8001/invoke",
    in_tier=False,
    cost_tier="paid",
)
#: A participant's own specialized `finetune` provider, on local accelerators (KFT §9/FT-K).
SPECIALIST = ProviderOffer(
    identity="mediastore:agent:slm-trainer",
    address="http://127.0.0.1:9100/invoke",
    in_tier=True,
    cost_tier="local",
)


class Dialed:
    """A recording :data:`Dispatch` — asserts on what was CONTACTED, not on what won."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], Grant]] = []

    def __call__(
        self, provider: ProviderOffer, job: dict[str, Any], grant: Grant
    ) -> dict[str, Any]:
        self.calls.append((provider.address, job, grant))
        return {"provider": provider.identity, "status": 200}

    @property
    def addresses(self) -> list[str]:
        return [address for address, _, _ in self.calls]


def directory_returning(selection: Selection) -> Directory:
    def _select(_spec: dict[str, Any]) -> Selection:
        return _select.spec_seen.append(_spec) or selection  # type: ignore[attr-defined]

    _select.spec_seen = []  # type: ignore[attr-defined]
    return _select


def refuse_all_dispatch() -> Dispatch:
    def _dispatch(provider: ProviderOffer, job: dict[str, Any], grant: Grant) -> dict[str, Any]:
        raise AssertionError(f"nothing may be dialed: {provider.identity}")

    return _dispatch


class TestTheHappyPath:
    def test_a_local_only_exhaust_routes_to_the_specialist_and_is_dialed_direct(self) -> None:
        """The scenario's Step 6: local-only data → the specialist local provider (FT-K)."""
        dialed = Dialed()
        result = submit(
            exhaust_job(),
            directory=directory_returning(
                Selection(outcome="selected", provider=SPECIALIST, reason="specialized")
            ),
            dispatch=dialed,
        )
        assert result.ok
        assert result.provider == SPECIALIST
        assert result.reason == "specialized"
        assert dialed.addresses == ["http://127.0.0.1:9100/invoke"]
        assert result.plan is not None
        assert result.plan.effective_egress == "local-only"
        assert result.plan.cardinality == 300  # sized from the header's recordCount (FT-P)

    def test_the_receipt_carries_what_the_gate_decided(self) -> None:
        body = submit(
            exhaust_job(),
            directory=directory_returning(
                Selection(outcome="selected", provider=SPECIALIST, reason="sole")
            ),
            dispatch=Dialed(),
        ).describe()
        assert body["ok"] is True
        assert body["plan"]["effective_egress"] == "local-only"
        assert body["plan"]["union_license"] == "proprietary"
        assert body["plan"]["placement"]["tier"] == "local"
        assert body["provider"]["identity"] == "mediastore:agent:slm-trainer"

    def test_it_is_producer_agnostic(self) -> None:
        """A synthetic producer in a namespace nothing here knows about, same path."""
        job = exhaust_job(
            job="acme-labs:activity:ft-run/0001",
            base_model="acme-labs:model:tiny-base",
            dataset={
                "records": ["acme-labs:asset:blake3-ffff01"],
                "header": [
                    exhaust_header(
                        source="acme-labs",
                        datasetKind="support-transcripts",
                        license="CC-BY-4.0",
                        egress="exportable",
                        recordCount=42,
                    )
                ],
            },
        )
        result = submit(
            job,
            directory=directory_returning(
                Selection(outcome="selected", provider=GENERAL, reason="sole")
            ),
            dispatch=Dialed(),
        )
        assert result.ok
        assert result.plan is not None
        assert result.plan.effective_egress == "exportable"
        assert result.plan.union_license == "attribution"
        assert result.plan.cardinality == 42

    def test_the_job_spec_the_registry_is_asked_carries_the_ft_k_facets(self) -> None:
        directory = directory_returning(
            Selection(outcome="selected", provider=SPECIALIST, reason="explicit")
        )
        submit(
            exhaust_job(),
            directory=directory,
            dispatch=Dialed(),
            provider="mediastore:agent:slm-trainer",
        )
        assert directory.spec_seen == [  # type: ignore[attr-defined]
            {
                "capability": "finetune",
                "modality": "text-generation",
                "method": "qlora",
                "provider": "mediastore:agent:slm-trainer",
            }
        ]


class TestNothingIsDialedBeforeTheGatePasses:
    def test_an_undescribed_record_file_never_reaches_a_provider(self) -> None:
        result = submit(
            exhaust_job(dataset={"records": ["ns:asset:blake3-a1"], "header": []}),
            directory=directory_returning(
                Selection(outcome="selected", provider=SPECIALIST, reason="sole")
            ),
            dispatch=refuse_all_dispatch(),
        )
        assert not result.ok
        assert [p.code for p in result.report.problems] == ["header-missing"]
        assert result.provider is None

    def test_an_over_ceiling_estimate_never_reaches_a_provider(self) -> None:
        result = submit(
            exhaust_job(),
            grant=Grant(budget_units=1.0),
            directory=directory_returning(
                Selection(outcome="selected", provider=SPECIALIST, reason="sole")
            ),
            dispatch=refuse_all_dispatch(),
        )
        assert [p.code for p in result.report.problems] == ["budget"]

    def test_a_header_the_fetched_file_contradicts_stops_the_run(self) -> None:
        """§4.1: the inline copy is a claim, checked at the fetch, in the safe direction."""
        job = exhaust_job(
            dataset={
                "records": ["mediastore:asset:blake3-e9d7a1"],
                "header": [exhaust_header(egress="exportable")],
            }
        )
        result = submit(
            job,
            directory=directory_returning(
                Selection(outcome="selected", provider=GENERAL, reason="sole")
            ),
            dispatch=refuse_all_dispatch(),
            fetch=lambda _job: {
                "mediastore:asset:blake3-e9d7a1": FetchedRecords(
                    first_record=exhaust_header(), row_count=300
                )
            },
        )
        assert [p.code for p in result.report.problems] == ["header-mismatch"]


class TestTheProviderEnvelope:
    def test_a_local_only_corpus_is_never_handed_to_a_cross_boundary_provider(self) -> None:
        """§4.2 on provider choice: shipping the job out is the same breach as renting a GPU."""
        result = submit(
            exhaust_job(),
            directory=directory_returning(
                Selection(outcome="selected", provider=GENERAL, reason="sole")
            ),
            dispatch=refuse_all_dispatch(),
        )
        assert not result.ok
        problem = result.report.problems[0]
        assert problem.code == "provider-egress"
        assert "'paid'" in problem.message
        # The plan is still reported — the producer learns *why* its own data closed the door.
        assert result.plan is not None and result.plan.effective_egress == "local-only"

    def test_an_exportable_corpus_may_burst_to_the_cloud_capable_general_trainer(self) -> None:
        dialed = Dialed()
        job = exhaust_job(
            dataset={
                "records": ["mediastore:asset:blake3-e9d7a1"],
                "header": [exhaust_header(egress="exportable", license="CC-BY-4.0")],
            },
            compute={"class": "single-gpu-a100-80gb", "egress": "derived"},
        )
        result = submit(
            job,
            directory=directory_returning(
                Selection(outcome="selected", provider=GENERAL, reason="cheaper")
            ),
            dispatch=dialed,
        )
        assert result.ok
        assert result.plan is not None and result.plan.placement.tier == "cloud"
        assert dialed.addresses == ["http://127.0.0.1:8001/invoke"]

    def test_an_unbroken_tie_is_surfaced_to_the_caller(self) -> None:
        """FT-K: registration order is not a valid tiebreak, so the bridge does not invent one."""
        result = submit(
            exhaust_job(),
            directory=directory_returning(
                Selection(outcome="tie", candidates=(SPECIALIST, GENERAL))
            ),
            dispatch=refuse_all_dispatch(),
        )
        problem = result.report.problems[0]
        assert problem.code == "provider-tie"
        assert "mediastore:agent:slm-trainer" in problem.message

    def test_no_matching_provider_is_a_discovery_failure_not_a_waiting_run(self) -> None:
        result = submit(
            exhaust_job(),
            directory=directory_returning(Selection(outcome="none")),
            dispatch=refuse_all_dispatch(),
        )
        assert [p.code for p in result.report.problems] == ["no-provider"]

    def test_a_match_with_no_dialable_endpoint_is_refused(self) -> None:
        """The registry hands back addresses and never relays — so nothing to dial is fatal."""
        result = submit(
            exhaust_job(),
            directory=directory_returning(
                Selection(
                    outcome="selected",
                    provider=ProviderOffer(identity="ns:agent:ghost", address="", in_tier=True),
                    reason="sole",
                )
            ),
            dispatch=refuse_all_dispatch(),
        )
        assert [p.code for p in result.report.problems] == ["no-address"]


class TestReadingTheRegistrysAnswer:
    MATCH: dict[str, Any] = {
        "identity": "mediastore:agent:slm-trainer",
        "address": {
            "identity": "mediastore:agent:slm-trainer",
            "endpoints": {"a2a": "http://127.0.0.1:9100/.well-known/agent-card.json"},
        },
        "capabilities": [
            {
                "name": "finetune",
                "endpoint": "http://127.0.0.1:9100/invoke",
                "estUnits": 120,
                "unpriced": False,
                "tier": "local",
            }
        ],
        "estUnits": 120,
        "unpriced": False,
    }

    def test_a_match_projects_onto_an_address_and_a_trust_boundary(self) -> None:
        offer = offer_from(self.MATCH)
        assert offer.address == "http://127.0.0.1:9100/invoke"
        assert offer.in_tier is True
        assert offer.cost_tier == "local"
        assert offer.est_units == 120.0

    def test_a_paid_tier_is_outside_the_boundary(self) -> None:
        match = {**self.MATCH, "capabilities": [{"name": "finetune", "tier": "paid"}]}
        assert offer_from(match).in_tier is False

    def test_it_falls_back_to_the_provider_address_when_no_capability_endpoint(self) -> None:
        match = {**self.MATCH, "capabilities": [{"name": "finetune", "tier": "local"}]}
        assert offer_from(match).address.endswith("/.well-known/agent-card.json")

    def test_it_reads_the_registrys_three_outcomes(self) -> None:
        selected = selection_from(
            {"outcome": "selected", "provider": self.MATCH, "reason": "specialized"}
        )
        assert selected.outcome == "selected"
        assert selected.reason == "specialized"
        assert selected.provider is not None

        tie = selection_from({"outcome": "tie", "candidates": [self.MATCH, self.MATCH]})
        assert len(tie.candidates) == 2

        assert selection_from({"outcome": "none"}).provider is None

    def test_a_body_that_is_not_a_selection_is_no_provider_not_a_crash(self) -> None:
        assert selection_from("nonsense").outcome == "none"


class TestTheOfflineDirectory:
    def test_with_no_registry_this_trainer_is_the_only_candidate(self) -> None:
        selection = self_directory("agora:agent:trainer", "http://127.0.0.1:8001/invoke")({})
        assert selection.outcome == "selected"
        assert selection.reason == "sole"  # never claims a preference nothing compared
        assert selection.provider is not None and selection.provider.in_tier is True
