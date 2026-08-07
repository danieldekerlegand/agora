"""The KGP §7.1 license-class algebra, as KFT §4.3/§5.4 uses it.

Every training record and asset carries an SPDX **license class**. KFT asks two things of it:

* **§4.3 lineage** — the finetuned model's provenance records the **union** of the classes across
  its training corpus *and the base model's own license* (FT-B). A non-commercial base makes the
  model non-commercial regardless of the data, so "may this model ship commercially?" is
  answerable from its lineage without re-deriving the corpus.
* **§5.4 inheritance** — the model entity and every weight/export asset inherit that union.

Note what KFT does **not** ask: the license is *not* an admission gate at the provider. §4.3
records it; the *downstream consumer* admits or rejects the model with the class-based allowlist
it applies to a pack (KGP §7.1). So :data:`DEFAULT_POLICY` admits every class — a commons that
shipped one caller's allowlist as its default would be encoding somebody else's policy — and a
deployment that *does* have one passes it in. What the default still refuses is a training input
with **no license class at all**: the union is then unanswerable, and §5.4's inheritance would
silently publish bytes nobody classified.

The classification table is a **default**, not the contract: koine names
``policy/license-classes.json`` as the authority, so a deployment whose licenses this table has
never heard of supplies its own ``classify`` rather than editing this map. It **fails closed** —
an id this build cannot classify is ``proprietary``, the most restrictive class — because getting
it wrong the other way trains on data nobody checked, and that is not recoverable.

This mirrors ``knowledge/src/license.ts``, the same axis on the KGP bridge; the two are separate
implementations of one koine policy rather than shared source (ADR-0001: nothing crosses language
boundaries as source).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

#: The §7.1 classes, most to least permissive. The union of a set is the **last** one present.
LICENSE_CLASSES: tuple[str, ...] = (
    "public-domain",
    "permissive",
    "attribution",
    "share-alike",
    "non-commercial",
    "proprietary",
)

#: The most restrictive class — where an unclassifiable id lands (fail closed).
MOST_RESTRICTIVE = LICENSE_CLASSES[-1]

#: SPDX ids and the ecosystem pseudo-ids KGP §7.1 names, keyed uppercase.
_CLASSIFICATION: dict[str, str] = {
    "CC0-1.0": "public-domain",
    "PUBLIC-DOMAIN": "public-domain",
    "UNLICENSE": "public-domain",
    "MIT": "permissive",
    "APACHE-2.0": "permissive",
    "BSD-2-CLAUSE": "permissive",
    "BSD-3-CLAUSE": "permissive",
    "ISC": "permissive",
    "CC-BY-3.0": "attribution",
    "CC-BY-4.0": "attribution",
    "CC-BY-SA-3.0": "share-alike",
    "CC-BY-SA-4.0": "share-alike",
    "GPL-3.0-ONLY": "share-alike",
    "GPL-3.0-OR-LATER": "share-alike",
    "AGPL-3.0-ONLY": "share-alike",
    "CC-BY-NC-4.0": "non-commercial",
    "CC-BY-NC-SA-4.0": "non-commercial",
    "PROPRIETARY": "proprietary",
    "PERSONAL": "proprietary",
}

#: A deployment's own license policy, consulted before the built-in table.
Classifier = Callable[[str], str | None]


def classify(license_id: str, classifier: Classifier | None = None) -> str:
    """The §7.1 class ``license_id`` falls in. Unrecognized → ``proprietary`` (fails closed)."""
    own = classifier(license_id) if classifier is not None else None
    if own is not None:
        return own
    return _CLASSIFICATION.get(license_id.strip().upper(), MOST_RESTRICTIVE)


def union_class(classes: Iterable[str]) -> str:
    """The union of ``classes`` — the most restrictive present (KFT §4.3/§5.4).

    An empty set is vacuously ``public-domain``: nothing restricts it. Callers never reach that
    case through :class:`LicensePolicy`, which refuses an unlicensed input first.
    """
    ranked = [LICENSE_CLASSES.index(c) for c in classes if c in LICENSE_CLASSES]
    return LICENSE_CLASSES[max(ranked)] if ranked else LICENSE_CLASSES[0]


@dataclass(frozen=True)
class LicensePolicy:
    """A deployment's §7.1 posture: which classes it will train on, and how it classifies."""

    #: The admitted classes. ``None`` (the default) admits every class — see the module note.
    allowlist: tuple[str, ...] | None = None
    #: The deployment's own classifier, consulted before the built-in table.
    classifier: Classifier | None = None

    def classify(self, license_id: str) -> str:
        return classify(license_id, self.classifier)

    def admits(self, license_class: str) -> bool:
        return self.allowlist is None or license_class in self.allowlist

    def describe(self) -> dict[str, object]:
        """A reportable view — what a rejection message and a receipt both quote."""
        return {"allowlist": list(self.allowlist) if self.allowlist is not None else "all"}


#: The commons default: record the class, gate on nothing but its absence (KFT §4.3).
DEFAULT_POLICY = LicensePolicy()
