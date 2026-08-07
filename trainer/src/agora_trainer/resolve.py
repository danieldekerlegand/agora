"""Admission-time resolution of a job's data-plane inputs (KFT §4.2/§7, FT-B/FT-E).

A finetune job references its training data and base model by id, never inline (KFT §4.1). To
apply the egress gate (§4.2) and the spend estimate (§7) the trainer must first learn, for each
referenced input, its **egress class** and its sample **cardinality** — the base-model entity's
egress included (FT-B). In a live deployment that is a `fetch:asset` metadata call (KMI §7) per
media asset and a KGP pack lookup per knowledge ref; this build ships neither, so the DEFAULT
resolver is an honest **offline stand-in** — it treats every input as ``exportable`` with a
nominal cardinality, exactly as the LLaMA-Factory adapter replays a recorded run rather than
fabricating a GPU. A test (or a real deployment) injects a resolver returning real per-input
facts; the seam is the same injection pattern the engine adapter uses for its run source.

**A record file is the exception, and deliberately so** (KFT §4.1, FT-N/FT-P). Its
``dataset-jsonl-header`` rides the job manifest precisely so its egress class, license and row
count are resolvable **without** fetching a byte — that is the whole reason the inline copy
exists. So the offline resolver does not stand in for a record file: it reads the real declared
facts off the header (:mod:`agora_trainer.records`), and the fetch, when it happens, only
*verifies* them.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .egress import EXPORTABLE, most_restrictive
from .licensing import DEFAULT_POLICY, LicensePolicy, union_class
from .records import headers_of, records_of

#: The nominal per-corpus sample count the offline resolver assumes when it cannot fetch real
#: metadata. A live resolver replaces this with the cardinality fetched from KMI/KGP (KFT §7,
#: FT-E); the estimate (:mod:`agora_trainer.cost`) is only as good as this number, hence the
#: contract's insistence that it be *resolved*, not read off the static manifest figure.
DEFAULT_CARDINALITY = 1000


@dataclass(frozen=True)
class RecordFacts:
    """The admission-relevant facts about one referenced input (a pack, an asset, or the base)."""

    #: The KINP/KGP/KMI id this fact is about.
    ref: str
    #: The record's egress class (KGP §7.2) — the input to the §4.2/FT-B aggregation.
    egress: str = EXPORTABLE
    #: The SPDX license class (KGP §7.1) — carried for the §5.4 union-license inheritance (US-4).
    license: str | None = None
    #: The number of training samples this input contributes — the input to the §7 estimate.
    samples: int = 0


@dataclass(frozen=True)
class ResolvedInputs:
    """A job's resolved inputs: its base-model entity and its training data (KFT §4.1)."""

    #: The base-model entity's facts — part of the egress/license aggregation (FT-B), never a
    #: training sample itself.
    base: RecordFacts
    #: The resolved KGP knowledge packs.
    knowledge: tuple[RecordFacts, ...] = ()
    #: The resolved KMI media assets.
    media: tuple[RecordFacts, ...] = ()
    #: The resolved ``dataset.records[]`` training-record files — a producer's exhaust (FT-M),
    #: each fact read off its positional ``dataset-jsonl-header`` (FT-N/FT-P).
    records: tuple[RecordFacts, ...] = ()

    @property
    def data(self) -> tuple[RecordFacts, ...]:
        """The training data (knowledge ∪ media ∪ records) — what the estimate is sized from."""
        return (*self.knowledge, *self.media, *self.records)

    @property
    def all_inputs(self) -> tuple[RecordFacts, ...]:
        """Every input the egress gate aggregates over: ``{data ∪ base}`` (KFT §4.2, FT-B)."""
        return (self.base, *self.data)

    @property
    def effective_egress(self) -> str:
        """The §4.2 effective egress class — most-restrictive over ``{data ∪ base}`` (FT-B)."""
        return most_restrictive(r.egress for r in self.all_inputs)

    @property
    def cardinality(self) -> int:
        """Total training-sample count across the data (the base is not a sample)."""
        return sum(r.samples for r in self.data)

    def union_license(self, policy: LicensePolicy = DEFAULT_POLICY) -> str:
        """The §4.3/§5.4 union license class over ``{data ∪ base}`` (FT-B).

        Most restrictive wins: a non-commercial base makes the model non-commercial however
        permissive the corpus. An input this build could not describe carries no class and is
        skipped — the *declared* ones are what a record file's header guarantees (FT-N), and
        :func:`~agora_trainer.records.check_dataset` is what refuses a header that omits it.
        """
        return union_class(policy.classify(r.license) for r in self.all_inputs if r.license)


#: A resolver maps a job to its resolved inputs — the injection seam for a live `fetch:asset`
#: path (KMI §7) or a test's explicit facts.
Resolver = Callable[[dict[str, Any]], ResolvedInputs]


def record_facts(job: dict[str, Any]) -> tuple[RecordFacts, ...]:
    """The ``dataset.records[]`` facts, read off the inline headers — no fetch (FT-N/FT-P).

    Unlike a pack or a media asset, a record file's admission facts are *declared in the
    manifest*: that is what ``dataset.header`` is for. So these are the producer's real numbers,
    not a stand-in — the egress class read explicitly (never inferred from ``tier``, FT-N), the
    license class, and ``recordCount`` as the cardinality the §7 estimate is sized from (FT-P).
    A header positioned past the last ``records[]`` entry is the pre-0.4.0 degenerate form — a
    corpus description with no reference slot; its axes still count, but it contributes no rows.
    """
    headers = headers_of(job)
    refs = records_of(job)
    facts: list[RecordFacts] = []
    for index, header in enumerate(headers):
        if header is None:
            continue  # `check_dataset` reports it; nothing here guesses at its axes.
        described = index < len(refs)
        facts.append(
            RecordFacts(
                ref=refs[index] if described else f"/dataset/header/{index}",
                egress=header.egress,
                license=header.license,
                samples=(header.record_count or 0) if described else 0,
            )
        )
    return tuple(facts)


def default_resolver(job: dict[str, Any]) -> ResolvedInputs:
    """The offline stand-in: every *fetchable* input ``exportable``, nominally sized (KFT §4.1).

    Honest about what it can know without a live fabric: it cannot `fetch` real KMI/KGP metadata,
    so it does not pretend to — an unrestricted, nominally-sized corpus for the pack and asset
    refs. The ``dataset.records[]`` files are not a guess: :func:`record_facts` reads their
    declared headers, which ride the manifest for exactly this reason. A deployment injects a
    resolver that returns the fetched facts; a test injects :func:`static_resolver`.
    """
    dataset = job.get("dataset", {}) or {}
    base = RecordFacts(ref=str(job.get("base_model", "")))
    knowledge = tuple(
        RecordFacts(ref=str(ref), samples=DEFAULT_CARDINALITY)
        for ref in dataset.get("knowledge", ())
    )
    media = tuple(
        RecordFacts(ref=str(ref), samples=DEFAULT_CARDINALITY) for ref in dataset.get("media", ())
    )
    return ResolvedInputs(base=base, knowledge=knowledge, media=media, records=record_facts(job))


def static_resolver(inputs: ResolvedInputs) -> Resolver:
    """A resolver that returns fixed ``inputs`` regardless of the job — for tests and fixtures."""

    def _resolve(_job: dict[str, Any]) -> ResolvedInputs:
        return inputs

    return _resolve
