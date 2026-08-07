"""The KFT §4.1 record-file slot — a producer's exhaust, by reference (FT-M…FT-P).

The three negative cases koine's `e2e-producer-exhaust-finetune` scenario names as "what the
schema alone will pass" are each exercised here: a positional mismatch, a header/file
disagreement, and a count overrun. So is the trap FT-N exists to close — reading the egress class
off the descriptive trust tier.
"""

from __future__ import annotations

from typing import Any

from agora_trainer.admission import admit
from agora_trainer.egress import EXPORTABLE, LOCAL_ONLY
from agora_trainer.records import (
    FetchedRecords,
    Header,
    check_dataset,
    headers_of,
    paired,
    records_of,
    verify_fetched,
)
from agora_trainer.resolve import record_facts
from conftest import exhaust_header, exhaust_job, valid_text_job


def codes(problems: list[Any]) -> list[str]:
    return [p.code for p in problems]


class TestReadingAHeader:
    def test_it_reads_the_04_axes_the_gate_needs(self) -> None:
        header = Header.parse(exhaust_header())
        assert header.egress == LOCAL_ONLY
        assert header.record_count == 300
        assert header.license == "PERSONAL"
        assert header.tier == "personal"

    def test_an_absent_egress_takes_the_kgp_exportable_default(self) -> None:
        """KGP §7.2's default — which is why understating it is a producer bug (§4.1)."""
        header = Header.parse({k: v for k, v in exhaust_header().items() if k != "egress"})
        assert header.egress == EXPORTABLE

    def test_the_gate_never_infers_egress_from_the_trust_tier(self) -> None:
        """FT-N, both directions: the tier is descriptive, the class is enforcing.

        A `personal` corpus its owner is happy to publish must not be pinned, and — the dangerous
        one — a `curated` corpus that must not leave must not be green-lit.
        """
        publishable = Header.parse(exhaust_header(tier="personal", egress=EXPORTABLE))
        assert publishable.egress == EXPORTABLE

        embargoed = Header.parse(exhaust_header(tier="curated", egress=LOCAL_ONLY))
        assert embargoed.egress == LOCAL_ONLY

    def test_a_bare_object_is_the_degenerate_one_file_form(self) -> None:
        job = exhaust_job(dataset={"records": ["ns:asset:blake3-a1"], "header": exhaust_header()})
        assert len(headers_of(job)) == 1
        assert [ref for ref, _ in paired(job)] == ["ns:asset:blake3-a1"]

    def test_an_unreadable_recordcount_is_none_not_a_guess(self) -> None:
        assert Header.parse(exhaust_header(recordCount="lots")).record_count is None
        assert Header.parse(exhaust_header(recordCount=True)).record_count is None


class TestTheDatasetGate:
    def test_a_conformant_exhaust_passes(self) -> None:
        assert check_dataset(exhaust_job()) == []

    def test_a_records_entry_with_no_positional_header_is_rejected(self) -> None:
        """The scenario's negative case 2: three files, two headers — one is undescribed."""
        job = exhaust_job(
            dataset={
                "records": ["ns:asset:blake3-a1", "ns:asset:blake3-b2", "ns:asset:blake3-c3"],
                "header": [exhaust_header(), exhaust_header()],
            }
        )
        problems = check_dataset(job)
        assert codes(problems) == ["header-missing"]
        assert problems[0].path == "/dataset/header/2"
        assert "FT-O" in problems[0].message

    def test_more_headers_than_files_is_rejected_too(self) -> None:
        job = exhaust_job(
            dataset={
                "records": ["ns:asset:blake3-a1"],
                "header": [exhaust_header(), exhaust_header()],
            }
        )
        assert codes(check_dataset(job)) == ["header-orphan"]

    def test_a_header_with_no_records_is_the_pre_040_form_not_an_error(self) -> None:
        """`header` predates the `records[]` slot; a lone one describes a corpus, harmlessly."""
        assert check_dataset(valid_text_job()) == []

    def test_an_unknown_egress_token_is_refused_rather_than_coerced(self) -> None:
        """Coercion is how `local-only` becomes `exportable` by accident."""
        job = exhaust_job(
            dataset={"records": ["ns:asset:blake3-a1"], "header": [exhaust_header(egress="maybe")]}
        )
        problems = check_dataset(job)
        assert codes(problems) == ["header-egress"]
        assert "FT-N" in problems[0].message

    def test_a_header_without_a_license_is_refused(self) -> None:
        header = {k: v for k, v in exhaust_header().items() if k != "license"}
        job = exhaust_job(dataset={"records": ["ns:asset:blake3-a1"], "header": [header]})
        assert codes(check_dataset(job)) == ["license-missing"]

    def test_rows_smuggled_into_the_header_are_refused(self) -> None:
        """KFT §4.1 is by-reference only — the rows live in the asset, never in the manifest."""
        job = exhaust_job(
            dataset={
                "records": ["ns:asset:blake3-a1"],
                "header": [exhaust_header(rows=[{"instruction": "…", "output": "…"}])],
            }
        )
        problems = check_dataset(job)
        assert codes(problems) == ["records-inlined"]
        assert problems[0].path == "/dataset/header/0/rows"

    def test_a_non_object_header_entry_is_reported_not_guessed_at(self) -> None:
        job = exhaust_job(dataset={"records": ["ns:asset:blake3-a1"], "header": ["nope"]})
        assert codes(check_dataset(job)) == ["header-missing"]


class TestCardinalityAndTheEgressAggregate:
    def test_the_estimate_is_sized_from_recordcount(self) -> None:
        """FT-P: one asset id may hold ten rows or ten million, so the header carries which."""
        facts = record_facts(exhaust_job())
        assert [f.samples for f in facts] == [300]
        assert [f.ref for f in facts] == ["mediastore:asset:blake3-e9d7a1"]

    def test_a_local_only_record_file_pins_the_whole_run(self) -> None:
        admission = admit(exhaust_job())
        assert admission.plan is not None
        assert admission.plan.effective_egress == LOCAL_ONLY
        assert admission.plan.cardinality == 300
        # §4.2: pinned to local/in-tier compute, never bursting.
        assert admission.plan.placement.is_local

    def test_a_cloud_class_over_a_local_only_exhaust_is_rejected(self) -> None:
        """The scenario's Step 6 — refused with a report, never silently re-pinned."""
        admission = admit(exhaust_job(compute={"class": "single-gpu-a100-80gb"}))
        assert admission.plan is None
        assert codes(list(admission.report.problems)) == ["egress-cross-boundary"]

    def test_a_descriptive_only_header_still_contributes_its_axes(self) -> None:
        """The pre-0.4.0 form describes a corpus it cannot reference — its class still counts."""
        job = valid_text_job(
            dataset={
                "knowledge": ["kgp:pack:sha256-7b1e"],
                "header": exhaust_header(recordCount=0),
            }
        )
        admission = admit(job)
        assert admission.plan is not None
        assert admission.plan.effective_egress == LOCAL_ONLY
        # It contributes no rows — only the knowledge pack's nominal cardinality.
        assert admission.plan.cardinality == 1000


class TestVerifyingTheInlineHeaderAgainstTheFile:
    JOB = exhaust_job()
    REF = "mediastore:asset:blake3-e9d7a1"

    def test_an_agreeing_file_verifies(self) -> None:
        fetched = {self.REF: FetchedRecords(first_record=exhaust_header(), row_count=300)}
        assert verify_fetched(self.JOB, fetched) == []

    def test_a_file_that_contradicts_its_inline_header_rejects(self) -> None:
        """Negative case 1: the inline copy claimed `exportable`, the file said otherwise."""
        job = exhaust_job(
            dataset={"records": [self.REF], "header": [exhaust_header(egress=EXPORTABLE)]}
        )
        fetched = {self.REF: FetchedRecords(first_record=exhaust_header(), row_count=300)}
        problems = verify_fetched(job, fetched)
        assert codes(problems) == ["header-mismatch"]

    def test_a_count_overrun_fails_the_run(self) -> None:
        """The scenario's negative case 3: the ceiling was granted against 300, not 3,000,000."""
        fetched = {self.REF: FetchedRecords(first_record=exhaust_header(), row_count=3_000_000)}
        problems = verify_fetched(self.JOB, fetched)
        assert codes(problems) == ["record-count-overrun"]
        assert "FT-P" in problems[0].message

    def test_fewer_rows_than_declared_is_not_an_overrun(self) -> None:
        fetched = {self.REF: FetchedRecords(first_record=exhaust_header(), row_count=12)}
        assert verify_fetched(self.JOB, fetched) == []

    def test_a_reference_this_build_did_not_fetch_is_not_second_guessed(self) -> None:
        assert verify_fetched(self.JOB, {}) == []
        assert records_of(self.JOB) == (self.REF,)
