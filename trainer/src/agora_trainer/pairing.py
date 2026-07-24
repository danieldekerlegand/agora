"""Paired multimodal training samples (KFT §4.1, FT-I) + the lazy `fetch:asset` seam (KMI §7).

Multimodal fine-tuning (`image-text-to-text`, `video-text-to-text`, and the caption side of
`text-to-image` / `text-to-video`) trains on **pairs** — which image goes with which caption.
FT-I fixes where that pairing lives: **not** in the ``dataset.knowledge[]`` / ``dataset.media[]``
corpus arrays (those are the *fetch/egress manifest* — which corpora to pull and gate), but in the
**dataset-jsonl-header training records** (koine:10): a row references a KMI ``asset`` id *and* its
``text``. Alignment thus travels with the same records that already carry license + trust tier.

This module is the join reader (:func:`paired_samples`) and the KMI ``fetch:asset`` seam
(:data:`AssetFetch` — the media bytes/metadata a run pulls lazily, KMI §7). Both are injected the
same way the engine adapter injects its run source: a live deployment supplies the real
`fetch:asset` path and the actual JSONL training records; this build ships an honest offline
stand-in (:func:`default_fetch`) and reads records from a recorded fixture.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .egress import EXPORTABLE


@dataclass(frozen=True)
class PairedSample:
    """One FT-I training record's join: a KMI ``asset`` id and the ``text`` paired with it.

    The pairing rides the dataset-jsonl-header training records, never the corpus arrays
    (KFT §4.1, FT-I): a row names both sides, so the image↔caption alignment travels with the
    same records that carry the set's license + trust tier.
    """

    asset: str
    text: str


@dataclass(frozen=True)
class AssetMeta:
    """The metadata a KMI ``fetch:asset`` call returns (KMI §7) — what data-prep + admission need.

    The bytes are fetched lazily and never inlined into the job (KFT §4.1); this is the envelope
    that rides with them: the asset's own egress class (§4.2/FT-B input) and license (§4.3/§5.4).
    """

    asset: str
    egress: str = EXPORTABLE
    license: str | None = None
    media_type: str = ""


#: The KMI ``fetch:asset`` seam (KMI §7): resolve one asset id to its metadata. A live deployment
#: injects the real grant-scoped fetch; the offline stand-in is :func:`default_fetch`.
AssetFetch = Callable[[str], AssetMeta]


def default_fetch(asset: str) -> AssetMeta:
    """The offline `fetch:asset` stand-in: an ``exportable`` asset with no known license.

    Honest about what it can know without a live fabric — it cannot dial a real KMI producer, so
    it does not pretend to per-asset facts it has not fetched. A deployment injects the real path.
    """
    return AssetMeta(asset=asset)


def paired_samples(records: Iterable[Mapping[str, Any]]) -> tuple[PairedSample, ...]:
    """Read the ``(asset, text)`` pairs from the training records (FT-I).

    A training record is a JSONL row (past the header) that names a KMI ``asset`` id and its
    ``text``. A row missing either side is not a usable pair and is skipped — the arrays remain
    the fetch manifest, the records are the join, and only complete joins train.
    """
    samples: list[PairedSample] = []
    for row in records:
        asset = row.get("asset")
        text = row.get("text")
        if isinstance(asset, str) and asset and isinstance(text, str) and text:
            samples.append(PairedSample(asset=asset, text=text))
    return tuple(samples)


def fetch_all(
    samples: Iterable[PairedSample], fetch: AssetFetch = default_fetch
) -> tuple[AssetMeta, ...]:
    """Lazily `fetch:asset` every paired sample's media asset (KMI §7), in record order.

    Modeled as the eager offline resolution of the lazy fetch a live run streams: one
    `fetch:asset` per referenced asset, de-duplicated, so a corpus is pulled by reference and
    never inlined into the job (KFT §4.1).
    """
    seen: set[str] = set()
    metas: list[AssetMeta] = []
    for sample in samples:
        if sample.asset in seen:
            continue
        seen.add(sample.asset)
        metas.append(fetch(sample.asset))
    return tuple(metas)
