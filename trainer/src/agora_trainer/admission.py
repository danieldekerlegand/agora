"""Admission — the single gate a job passes before any compute is committed (KFT §3/§4.2/§7).

This composes every admission check in the order the spec commits them, each producing the shared
structured :class:`~agora_trainer.validate.Report` so a caller gets one verdict over CLI or HTTP:

1. **shape + modality × method** — :func:`~agora_trainer.validate.validate_job` (US-2, FT-F);
2. **the by-reference dataset** — :func:`~agora_trainer.records.check_dataset` (§4.1,
   FT-M/FT-N/FT-O): one ``dataset-jsonl-header`` per referenced record file, a readable egress
   class and a declared license on each, and no rows smuggled into the manifest;
3. **the egress gate** — the §4.2 effective egress over ``{data ∪ base}`` (FT-B), resolved by
   :mod:`agora_trainer.resolve` and reduced by :mod:`agora_trainer.egress`; an explicit
   ``compute.egress: exportable`` that the data contradicts is rejected here;
4. **the license union** — the §4.3/§5.4 class the output inherits, checked against the
   deployment's :class:`~agora_trainer.licensing.LicensePolicy` (which admits everything by
   default — KFT records the class, it does not gate on it here);
5. **SkyPilot placement** under the egress gate — :func:`~agora_trainer.placement.select_placement`
   (§4.2 cross-boundary rejection, FT-J unsatisfiable-pin rejection);
6. **the spend ceiling** — the §7 gpu-seconds estimate (:mod:`agora_trainer.cost`), computed
   **after** resolving dataset cardinality — a record file's from its header's ``recordCount``
   (FT-P) — and checked against the grant (:mod:`agora_trainer.grant`, FT-E).

It returns an :class:`Admission`: an OK report plus the resolved :class:`AdmissionPlan` (effective
egress, placement, estimate, cardinality) when admitted, or an INVALID report carrying the one
specific problem when rejected — never a partial commit, never a silent downgrade.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .cost import epochs_of, estimate_gpu_seconds
from .egress import EXPORTABLE, LOCAL_ONLY
from .grant import UNGATED, Grant
from .licensing import DEFAULT_POLICY, LicensePolicy
from .placement import Placement, PlacementRejected, select_placement
from .records import check_dataset
from .resolve import ResolvedInputs, Resolver, default_resolver
from .validate import Problem, Report, Status, validate_job


@dataclass(frozen=True)
class AdmissionPlan:
    """The resolved plan an admitted job carries into the run — what §4.2/§7 decided."""

    #: The §4.2 effective egress class over ``{data ∪ base}`` (FT-B).
    effective_egress: str
    #: The chosen SkyPilot placement under that egress (KFT §4.2).
    placement: Placement
    #: The admission-time gpu-seconds estimate that cleared the grant ceiling (KFT §7, FT-E).
    estimate_units: float
    #: The resolved training-sample cardinality the estimate was sized from.
    cardinality: int
    #: The §4.3 union license class over ``{data ∪ base}`` (FT-B) — what the finetuned model and
    #: every weight/export asset inherit (§5.4), carried so a consumer can answer "may this ship
    #: commercially?" from the lineage without re-deriving the corpus.
    union_license: str
    #: The resolved ``{base ∪ data}`` facts admission decided on — carried so the runner can build
    #: the §5.4 output inheritance (egress + union license) without re-resolving (US-4).
    resolved: ResolvedInputs


@dataclass(frozen=True)
class Admission:
    """The admission verdict — a :class:`Report` plus, when admitted, the resolved plan."""

    report: Report
    plan: AdmissionPlan | None = None

    @property
    def ok(self) -> bool:
        """True only when the job was admitted (an :class:`AdmissionPlan` was produced)."""
        return self.plan is not None


def _reject(problem: Problem) -> Admission:
    """A rejection verdict — INVALID status carrying the one problem that stopped admission."""
    return Admission(report=Report(status=Status.INVALID, problems=(problem,)))


def _effective_egress(job: dict[str, Any], resolved: ResolvedInputs) -> tuple[str, Problem | None]:
    """The §4.2 effective egress, honoring the ``compute.egress`` pin/assertion (FT-B).

    ``derived`` (default) uses the class computed from ``{data ∪ base}``; ``local-only`` pins the
    run at least that restrictive; ``exportable`` is an *assertion* the provider MUST still verify
    against the data and reject on violation (a `local-only` input) — never honor blindly.
    """
    computed = resolved.effective_egress
    requested = (job.get("compute", {}) or {}).get("egress", "derived")
    if requested == LOCAL_ONLY:
        return LOCAL_ONLY, None
    if requested == EXPORTABLE:
        if computed == LOCAL_ONLY:
            return computed, Problem(
                code="egress-assertion",
                path="/compute/egress",
                message=(
                    "compute.egress asserts 'exportable' but an input (data or base) is local-only "
                    "(KFT §4.2, FT-B); the assertion is verified against the data and rejected on "
                    "violation, never honored blindly"
                ),
            )
        return EXPORTABLE, None
    return computed, None  # "derived": take the computed class as-is.


def admit(
    job: dict[str, Any],
    *,
    grant: Grant = UNGATED,
    resolver: Resolver = default_resolver,
    licenses: LicensePolicy = DEFAULT_POLICY,
) -> Admission:
    """Run every admission check (KFT §3/§4.1/§4.2/§4.3/§7) and return the :class:`Admission`."""
    report = validate_job(job)
    if not report.ok:
        return Admission(report=report)  # shape / modality×method (US-2) — nothing resolved yet.

    dataset_problems = check_dataset(job)
    if dataset_problems:
        # §4.1 runs before resolution on purpose: an undescribed record file is precisely the
        # case where resolving would have to guess at the axes the gate decides on.
        return Admission(report=Report(status=Status.INVALID, problems=tuple(dataset_problems)))

    resolved = resolver(job)
    effective, egress_problem = _effective_egress(job, resolved)
    if egress_problem is not None:
        return _reject(egress_problem)

    union_license = resolved.union_license(licenses)
    if not licenses.admits(union_license):
        return _reject(
            Problem(
                code="license-refused",
                path="/dataset",
                message=(
                    f"the corpus' union license class {union_license!r} (KFT §4.3 over "
                    "{data ∪ base}, FT-B) is outside this deployment's allowlist "
                    f"{licenses.describe()['allowlist']}; the finetuned model would inherit it "
                    "(§5.4), so the job is refused before any compute is committed"
                ),
            )
        )

    compute = job.get("compute", {}) or {}
    try:
        placement = select_placement(
            effective_egress=effective,
            requested_class=str(compute.get("class", "")),
            modality=str(job["modality"]),
        )
    except PlacementRejected as exc:
        return _reject(exc.problem)

    estimate = estimate_gpu_seconds(
        modality=str(job["modality"]),
        method=str(job["method"]),
        cardinality=resolved.cardinality,
        epochs=epochs_of(job),
    )
    if not grant.admits(estimate):
        return _reject(
            Problem(
                code="budget",
                path="/",
                message=(
                    f"estimated {estimate} gpu-seconds exceeds the grant ceiling "
                    f"{grant.budget_units} (KFT §7, FT-E); rejected before provisioning"
                ),
            )
        )

    plan = AdmissionPlan(
        effective_egress=effective,
        placement=placement,
        estimate_units=estimate,
        cardinality=resolved.cardinality,
        union_license=union_license,
        resolved=resolved,
    )
    return Admission(report=Report(status=Status.OK), plan=plan)
