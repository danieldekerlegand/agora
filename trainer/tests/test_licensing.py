"""The KGP §7.1 license axis as KFT §4.3/§5.4 uses it — union, inheritance, and fail-closed."""

from __future__ import annotations

from agora_trainer.admission import admit
from agora_trainer.licensing import (
    DEFAULT_POLICY,
    LicensePolicy,
    classify,
    union_class,
)
from agora_trainer.resolve import RecordFacts, ResolvedInputs, static_resolver
from conftest import exhaust_header, exhaust_job


class TestClassification:
    def test_it_classifies_the_spdx_ids_the_policy_names(self) -> None:
        assert classify("CC0-1.0") == "public-domain"
        assert classify("apache-2.0") == "permissive"
        assert classify("CC-BY-4.0") == "attribution"
        assert classify("CC-BY-NC-4.0") == "non-commercial"
        assert classify("PERSONAL") == "proprietary"

    def test_an_unrecognized_id_fails_closed(self) -> None:
        """Getting it wrong the other way trains on data nobody checked — not recoverable."""
        assert classify("WEIRD-LICENSE-9.9") == "proprietary"

    def test_a_deployment_supplies_its_own_policy_rather_than_editing_the_table(self) -> None:
        policy = LicensePolicy(classifier=lambda lic: "permissive" if lic == "HOUSE-1.0" else None)
        assert policy.classify("HOUSE-1.0") == "permissive"
        assert policy.classify("CC-BY-4.0") == "attribution"  # falls through to the table


class TestTheUnion:
    def test_the_union_is_the_most_restrictive_present(self) -> None:
        assert union_class(["permissive", "attribution", "share-alike"]) == "share-alike"

    def test_a_non_commercial_base_makes_the_model_non_commercial(self) -> None:
        """FT-B: the base model's own license joins the union, whatever the corpus says."""
        resolved = ResolvedInputs(
            base=RecordFacts(ref="refkb:model:flux-dev", license="CC-BY-NC-4.0"),
            knowledge=(RecordFacts(ref="kgp:pack:sha256-1", license="CC0-1.0", samples=10),),
        )
        assert resolved.union_license() == "non-commercial"

    def test_an_input_this_build_could_not_describe_is_skipped(self) -> None:
        resolved = ResolvedInputs(base=RecordFacts(ref="refkb:model:qwen"))
        assert resolved.union_license() == "public-domain"


class TestTheAdmissionPosture:
    def test_the_commons_default_records_the_class_and_gates_on_nothing(self) -> None:
        """KFT §4.3 makes license descriptive at the provider; the *consumer* gates on it."""
        assert DEFAULT_POLICY.allowlist is None
        admission = admit(exhaust_job())
        assert admission.plan is not None
        assert admission.plan.union_license == "proprietary"  # the PERSONAL exhaust

    def test_a_deployment_allowlist_refuses_the_corpus_with_a_graded_reason(self) -> None:
        policy = LicensePolicy(allowlist=("public-domain", "permissive", "attribution"))
        admission = admit(exhaust_job(), licenses=policy)
        assert admission.plan is None
        problem = admission.report.problems[0]
        assert problem.code == "license-refused"
        assert "proprietary" in problem.message
        assert "§5.4" in problem.message  # names what the output would have inherited

    def test_an_admitted_corpus_under_the_same_allowlist_passes(self) -> None:
        policy = LicensePolicy(allowlist=("public-domain", "permissive", "attribution"))
        job = exhaust_job(
            dataset={
                "records": ["mediastore:asset:blake3-e9d7a1"],
                "header": [exhaust_header(license="CC-BY-4.0", egress="exportable")],
            }
        )
        resolver = static_resolver(
            ResolvedInputs(
                base=RecordFacts(ref="refkb:model:qwen", license="Apache-2.0"),
                records=(RecordFacts(ref="mediastore:asset:blake3-e9d7a1", license="CC-BY-4.0"),),
            )
        )
        admission = admit(job, licenses=policy, resolver=resolver)
        assert admission.plan is not None
        assert admission.plan.union_license == "attribution"
