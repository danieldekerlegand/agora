"""SkyPilot-gated compute placement under the KFT §4.2 egress gate (FT-J).

Placement is **contract-governed**, not an operator setting (KFT §4.2): a `local-only`-effective
run (:mod:`agora_trainer.egress`) MUST run on local / in-tier compute and MUST NOT be shipped to
a backend that crosses the trust boundary (a rented/cloud GPU, a managed training API); only an
all-`exportable` corpus MAY burst to external compute. The provider selects the backend via
SkyPilot — local (MPS / a local GPU) or a rented/cloud GPU of the requested class — and *this*
module is the admission-time decision that gates SkyPilot, returning the chosen :class:`Placement`
or REJECTING with a structured :class:`~agora_trainer.validate.Problem`:

* a `local-only` run naming a cross-boundary ``compute.class`` is **rejected** — never silently
  downgraded, never silently placed local (the §4.2 clause);
* a `local-only` run whose local tier **cannot run** the job (e.g. video-diffusion on an
  under-provisioned tier) is **rejected at admission** — **FT-J**: an impossible-to-place gated
  job is a rejected job, never a hang and never a silent cloud placement (a privacy breach).
"""

from __future__ import annotations

from dataclasses import dataclass

from .egress import is_local_only
from .validate import Problem

#: The two placement tiers SkyPilot targets.
LOCAL_TIER = "local"
CLOUD_TIER = "cloud"

#: The SkyPilot backend label for each tier — local MPS/GPU vs a rented/cloud GPU.
LOCAL_BACKEND = "skypilot-local"
CLOUD_BACKEND = "skypilot-cloud"

#: The ``compute.class`` values served by the local / in-tier backend. Everything else — a named
#: cloud GPU class such as ``single-gpu-a100-80gb`` — crosses the trust boundary.
LOCAL_CLASSES: frozenset[str] = frozenset({"local", "local-mps", "local-cpu", "local-gpu"})

#: The modalities the local tier is provisioned to run. Video-diffusion (``text-to-video``,
#: ``video-text-to-text``) exceeds it, so a `local-only` job in those modalities cannot be placed
#: at all (FT-J). A live deployment derives this from the tier's real GPU inventory rather than a
#: constant; the constant is the honest offline stand-in.
LOCAL_TIER_MODALITIES: frozenset[str] = frozenset(
    {"text-generation", "image-text-to-text", "text-to-image"}
)


@dataclass(frozen=True)
class Placement:
    """The admitted compute placement — which tier, which SkyPilot backend, under which egress."""

    tier: str
    backend: str
    compute_class: str
    egress: str

    @property
    def is_local(self) -> bool:
        return self.tier == LOCAL_TIER


class PlacementRejected(Exception):
    """The egress gate forbids every placement for this job (KFT §4.2/FT-J) — carries a Problem."""

    def __init__(self, problem: Problem) -> None:
        self.problem = problem
        super().__init__(problem.message)


def is_local_class(compute_class: str) -> bool:
    """True when ``compute_class`` is served by the local / in-tier backend (never cloud)."""
    return compute_class in LOCAL_CLASSES or compute_class.startswith("local-")


def select_placement(*, effective_egress: str, requested_class: str, modality: str) -> Placement:
    """Choose the SkyPilot placement under the §4.2 gate, or raise :class:`PlacementRejected`.

    ``local-only`` → local/in-tier only; a cross-boundary ``requested_class`` or a modality the
    local tier cannot run is rejected (FT-J). ``exportable`` → the requested class as-is: local if
    a local class was asked for, otherwise a cloud burst.
    """
    requested_local = is_local_class(requested_class)
    if is_local_only(effective_egress):
        if not requested_local:
            raise PlacementRejected(
                Problem(
                    code="egress-cross-boundary",
                    path="/compute/class",
                    message=(
                        f"run is local-only (KFT §4.2, FT-B) but compute.class {requested_class!r} "
                        "crosses the trust boundary; a local-only run MUST stay on local/in-tier "
                        "compute and is never silently downgraded or cloud-placed"
                    ),
                )
            )
        if modality not in LOCAL_TIER_MODALITIES:
            raise PlacementRejected(
                Problem(
                    code="egress-unsatisfiable",
                    path="/compute/class",
                    message=(
                        f"run is local-only but the local tier cannot run modality {modality!r} "
                        "(KFT §4.2, FT-J); an impossible-to-place gated job is rejected at "
                        "admission, never hung and never cloud-placed"
                    ),
                )
            )
        return Placement(LOCAL_TIER, LOCAL_BACKEND, requested_class, effective_egress)
    # all-`exportable`: honor the requested class — local if asked, else burst to cloud.
    if requested_local:
        return Placement(LOCAL_TIER, LOCAL_BACKEND, requested_class, effective_egress)
    return Placement(CLOUD_TIER, CLOUD_BACKEND, requested_class, effective_egress)
