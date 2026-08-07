"""The KFT §4.1 training-record slot — a producer's training exhaust, by reference (FT-M…FT-P).

`dataset.knowledge[]` and `dataset.media[]` name corpora an *authority* curated on purpose. An
ordinary application's **training exhaust** — accepted NL edits, generations, preference pairs,
QA labels — is neither a KGP pack (§2: entities/assertions/links over the immutable relation
registry) nor image/video/audio bytes, so KFT 0.4.0 gives it its own slot: `dataset.records[]`,
each entry a **KMI asset** carrying the registered ``application/vnd.koine.dataset+jsonl`` media
type (FT-M). The rows never enter the manifest; referencing the file as an asset is what keeps
the by-reference discipline honest.

What *does* ride the manifest is the file's **`dataset-jsonl-header`** — its first line, copied
inline, one per `records[]` entry (FT-O) — because the §4.2 egress gate and the §7 spend
estimate both have to run **before a byte moves**. This module is where those four deltas are
enforced:

* **FT-M** — the reference slot itself: :func:`records_of` reads it, and nothing here ever
  carries a row.
* **FT-N** — :attr:`Header.egress` is read **explicitly** off the header and **never inferred
  from `tier`**. KGP §7.2 makes the trust tier descriptive and the egress class enforcing;
  `personal` data that happens to be `exportable` (and `curated` data that is not) is exactly
  the case an inference gets wrong. An absent class takes KGP §7.2's `exportable` default, which
  is why understating it is a producer bug rather than a permissive choice.
* **FT-O** — the header is positional, one per referenced file (:func:`check_dataset`): a
  `records[]` entry with no header leaves the §4.2/§4.3 aggregate incomplete, so admission
  rejects rather than gating on a partial corpus.
* **FT-P** — :attr:`Header.record_count` is the only cardinality a provider has for the §7
  estimate without transferring the file, and :func:`verify_fetched` re-checks it *at* the fetch.

The inline header is a **claim made to skip the fetch**, so :func:`verify_fetched` is the other
half of the contract: a provider that later fetches the file MUST verify the inline copy against
the file's actual first record and reject on disagreement (§4.1) — the inline copy is a claim,
the file is the truth.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .egress import EGRESS_CLASSES, EXPORTABLE
from .validate import Problem

#: The ``record`` discriminator every ``dataset-jsonl-header`` carries as its first field.
HEADER_RECORD = "header"

#: The KMI media type a ``dataset.records[]`` asset carries (koine ``registry/media-types.tsv``,
#: KFT §4.1/FT-M). Published on the trainer's manifest so path search routes a record file here.
RECORDS_MEDIA_TYPE = "application/vnd.koine.dataset+jsonl"

#: The manifest port shape the record files arrive on (KFT §2).
RECORDS_SHAPE = "training-records"

#: Header keys that would carry the training **rows** rather than describe them. The job schema
#: already forbids an unknown key on ``dataset`` (``additionalProperties: false``), but the
#: header schema is deliberately open (``additionalProperties: true``) so an emitter can carry
#: its own provenance — which is the one place a producer could smuggle the corpus inline.
INLINE_KEYS: tuple[str, ...] = ("rows", "records", "samples", "data", "examples")


@dataclass(frozen=True)
class Header:
    """One ``dataset-jsonl-header`` — the file-level descriptor the §4 gate reads.

    Every axis is a **file-level aggregate** (FT-N/FT-P): :attr:`egress` is the most restrictive
    class over the file's rows, :attr:`license` the union of theirs, :attr:`record_count` their
    number. A producer whose rows differ in class splits the file rather than widening the header.
    """

    #: ``datasetKind`` — e.g. ``nl-edit``, ``generations``, ``preferences``, ``qa-labels``.
    kind: str
    #: The emitting participant's KINP namespace (identity.md §3.4).
    source: str
    #: The KGP §7 trust tier. **Descriptive only** — never read by the egress gate (FT-N).
    tier: str
    #: The SPDX / ecosystem license class (KGP §7.1); ``None`` when the header omits it.
    license: str | None
    #: The KGP §7.2 egress class, read explicitly (FT-N). Absent → the ``exportable`` default.
    egress: str
    #: Rows after the header (FT-P); ``None`` when the header omits it (uncostable, §7).
    record_count: int | None
    #: The koine spec version the emitter was built against.
    contract_version: str | None

    @classmethod
    def parse(cls, raw: Mapping[str, Any]) -> Header:
        """Read a header defensively — it arrived from an arbitrary producer, not from us.

        A malformed value never raises here: it degrades to the safe reading (an unrecognized
        ``egress`` token is **not** treated as ``exportable``-by-default, it is kept verbatim so
        :func:`check_dataset` can name it) and the shape gate reports it.
        """
        egress = raw.get("egress")
        count = raw.get("recordCount")
        return cls(
            kind=_text(raw.get("datasetKind")),
            source=_text(raw.get("source")),
            tier=_text(raw.get("tier")),
            license=_optional_text(raw.get("license")),
            egress=EXPORTABLE if egress is None else str(egress),
            record_count=count if isinstance(count, int) and not isinstance(count, bool) else None,
            contract_version=_optional_text(raw.get("contractVersion")),
        )


@dataclass(frozen=True)
class FetchedRecords:
    """What a `fetch:asset` of a record file reveals — the two facts §4.1/§7 re-check."""

    #: The file's actual first record, against which the inline header is verified (§4.1).
    first_record: Mapping[str, Any]
    #: The actual number of rows after that header — re-checked against FT-P's declaration.
    row_count: int


def records_of(job: Mapping[str, Any]) -> tuple[str, ...]:
    """The ``dataset.records[]`` asset ids — references, never rows (KFT §4.1, FT-M)."""
    dataset = job.get("dataset") or {}
    raw = dataset.get("records") or ()
    return tuple(str(ref) for ref in raw) if isinstance(raw, Sequence) else ()


def raw_headers_of(job: Mapping[str, Any]) -> tuple[Any, ...]:
    """``dataset.header`` normalized to a sequence — a bare object is the one-file form (FT-O)."""
    dataset = job.get("dataset") or {}
    raw = dataset.get("header")
    if raw is None:
        return ()
    if isinstance(raw, Mapping):
        return (raw,)
    return tuple(raw) if isinstance(raw, Sequence) and not isinstance(raw, str | bytes) else ()


def headers_of(job: Mapping[str, Any]) -> tuple[Header | None, ...]:
    """The parsed headers, positionally; a non-object entry parses to ``None`` (FT-O)."""
    return tuple(
        Header.parse(raw) if isinstance(raw, Mapping) else None for raw in raw_headers_of(job)
    )


def paired(job: Mapping[str, Any]) -> tuple[tuple[str, Header], ...]:
    """The ``(records[i], header[i])`` pairs — only those positions that have both (FT-O)."""
    headers = headers_of(job)
    pairs: list[tuple[str, Header]] = []
    for index, ref in enumerate(records_of(job)):
        header = headers[index] if index < len(headers) else None
        if header is not None:
            pairs.append((ref, header))
    return tuple(pairs)


def check_dataset(job: Mapping[str, Any]) -> list[Problem]:
    """The §4.1 record-slot gate: positional headers, a readable egress class, no inlined rows.

    Runs at admission, **before** anything is fetched or placed. Every problem names exactly one
    clause, so a producer gets a reason it can act on rather than a bare refusal.
    """
    problems: list[Problem] = []
    records = records_of(job)
    raw = raw_headers_of(job)
    headers = headers_of(job)

    # FT-O — one header per referenced file. An undescribed file makes the §4.2/§4.3 aggregate
    # incomplete, so the job is rejected rather than gated on a partial corpus.
    for index in range(len(records)):
        if index >= len(headers) or headers[index] is None:
            problems.append(
                Problem(
                    code="header-missing",
                    path=f"/dataset/header/{index}",
                    message=(
                        f"dataset.records[{index}] ({records[index]!r}) has no positional "
                        "dataset-jsonl-header (KFT §4.1, FT-O); its egress class and license "
                        "would be unknown, so the §4.2/§4.3 aggregate is incomplete and the job "
                        "is rejected rather than gated on a partial corpus"
                    ),
                )
            )
    # The mirror case is only an error once a file *is* referenced: before KFT 0.4.0 there was no
    # `records[]` slot at all, so a lone `header` describing an unreferenceable corpus is the
    # degenerate legacy form — still read for its axes (`resolve`), never a rejection.
    if records and len(headers) > len(records):
        problems.append(
            Problem(
                code="header-orphan",
                path=f"/dataset/header/{len(records)}",
                message=(
                    f"dataset.header has {len(headers)} entries but dataset.records has "
                    f"{len(records)}; the header array is positional, one per referenced file "
                    "(KFT §4.1, FT-O)"
                ),
            )
        )

    for index, header in enumerate(headers):
        if header is None:
            continue
        # FT-N — the gate reads this class and nothing else. An unrecognized token is refused
        # rather than coerced: coercion is how `local-only` becomes `exportable` by accident.
        if header.egress not in EGRESS_CLASSES:
            problems.append(
                Problem(
                    code="header-egress",
                    path=f"/dataset/header/{index}/egress",
                    message=(
                        f"unknown egress class {header.egress!r} (KGP §7.2 admits "
                        f"{', '.join(EGRESS_CLASSES)}); the §4.2 gate reads this class explicitly "
                        "and MUST NOT infer it from `tier` (KFT §4.2, FT-N)"
                    ),
                )
            )
        # §4.3/§5.4 — the header is where a record file's class is declared, and the union it
        # feeds is what the finetuned model and every weight asset inherit. An undeclared class
        # would make that union a guess, so the file is refused rather than classified for the
        # producer. (The job schema requires it too; this is the gate for a direct intake.)
        if header.license is None:
            problems.append(
                Problem(
                    code="license-missing",
                    path=f"/dataset/header/{index}/license",
                    message=(
                        "the dataset-jsonl-header carries no license class (KGP §7.1); the §4.3 "
                        "union license the finetuned model inherits (§5.4) is unanswerable "
                        "without it, so the file is refused rather than classified on the "
                        "producer's behalf"
                    ),
                )
            )

    problems.extend(_inline_problems(raw))
    return problems


def verify_fetched(job: Mapping[str, Any], fetched: Mapping[str, FetchedRecords]) -> list[Problem]:
    """Re-check the inline headers against the files, once fetched (§4.1 + §7/FT-P).

    The inline copy exists so the gate can run before any transfer; it is therefore a **claim**,
    and this is where it is checked against the truth. Two failures, both MUST-reject:

    * **header disagreement** — the file's first record contradicts the inline copy on an axis
      the gate decided on (`egress`, `license`, `tier`, `datasetKind`). Checked in the safe
      direction: any difference is a rejection, not a re-derivation.
    * **count overrun** (FT-P) — the file holds more rows than the header declared, so the run
      would train past the budget the grant was granted against (§7).

    ``fetched`` maps a ``records[]`` id to what its fetch revealed; a reference this build did
    not fetch is simply absent and is not second-guessed.
    """
    problems: list[Problem] = []
    for index, (ref, header) in enumerate(paired(job)):
        actual = fetched.get(ref)
        if actual is None:
            continue
        raw = actual.first_record
        first = Header.parse(raw) if isinstance(raw, Mapping) else None
        if first is None or first != header:
            problems.append(
                Problem(
                    code="header-mismatch",
                    path=f"/dataset/header/{index}",
                    message=(
                        f"the inline header for {ref!r} disagrees with the file's actual first "
                        "record (KFT §4.1); the inline copy is a claim made to skip the fetch, so "
                        "a disagreement rejects the job rather than re-deriving the gate"
                    ),
                )
            )
            continue
        declared = header.record_count
        if declared is not None and actual.row_count > declared:
            problems.append(
                Problem(
                    code="record-count-overrun",
                    path=f"/dataset/header/{index}/recordCount",
                    message=(
                        f"{ref!r} holds {actual.row_count} rows but its header declared "
                        f"{declared} (KFT §7, FT-P); the ceiling was granted against the declared "
                        "figure, so the run fails rather than training past its budget"
                    ),
                )
            )
    return problems


def _inline_problems(raw_headers: Sequence[Any]) -> list[Problem]:
    """Refuse a header that carries the rows instead of describing them (KFT §4.1)."""
    problems: list[Problem] = []
    for index, raw in enumerate(raw_headers):
        if not isinstance(raw, Mapping):
            continue
        for key in INLINE_KEYS:
            value = raw.get(key)
            if isinstance(value, list | tuple):
                problems.append(
                    Problem(
                        code="records-inlined",
                        path=f"/dataset/header/{index}/{key}",
                        message=(
                            f"dataset.header[{index}].{key} carries training rows inline; KFT "
                            "§4.1 is by-reference only — the rows live in the KMI asset named by "
                            "dataset.records[] and never enter the job manifest"
                        ),
                    )
                )
    return problems


def _text(value: Any) -> str:
    return str(value) if isinstance(value, str) else ""


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None
