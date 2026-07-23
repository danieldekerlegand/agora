"""The KFT §4.2 egress-class algebra — the NORMATIVE local-vs-cloud gate.

KGP §7.2 hard-gates a `local-only` record out of any export or **training set**. KFT §4.2
operationalizes that for a whole run: the run's **effective egress class** is the *most
restrictive* class across **all** its training data records/assets **and the base-model entity's
own egress class (FT-B)** — a can't-leave base pins an all-`exportable` corpus to local compute
just as a `local-only` record does. If any input is `local-only`, the run is `local-only` and
MUST stay on local / in-tier compute (:mod:`agora_trainer.placement`); only an all-`exportable`
corpus MAY burst to external compute.

The vocabulary is the KGP §7.2 axis (``provenance.schema.json`` ``egress`` ``$def``):
``exportable`` (default) or ``local-only`` — no third value. This module is the pure algebra;
*where* the per-input classes come from is :mod:`agora_trainer.resolve`, and *what the effective
class permits* is :mod:`agora_trainer.placement`.
"""

from __future__ import annotations

from collections.abc import Iterable

#: A record/asset/entity that MAY cross a project boundary (KGP §7.2 default).
EXPORTABLE = "exportable"
#: A record/asset/entity hard-gated to its originating trust boundary (KGP §7.2).
LOCAL_ONLY = "local-only"
#: The closed egress vocabulary, most-permissive first.
EGRESS_CLASSES: tuple[str, ...] = (EXPORTABLE, LOCAL_ONLY)


def is_local_only(egress: str) -> bool:
    """True when ``egress`` pins its bearer to the local trust boundary (KFT §4.2)."""
    return egress == LOCAL_ONLY


def most_restrictive(classes: Iterable[str]) -> str:
    """The effective class over ``classes`` — ``local-only`` if ANY is, else ``exportable``.

    This is the §4.2/FT-B aggregation: one `local-only` input makes the whole run `local-only`.
    An empty set is vacuously ``exportable`` (nothing restricts it).
    """
    return LOCAL_ONLY if any(c == LOCAL_ONLY for c in classes) else EXPORTABLE
