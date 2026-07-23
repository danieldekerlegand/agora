"""Output-egress enforcement at registration — the §5.4 gate (NORMATIVE, FT-A).

The §4.2 gate (:mod:`agora_trainer.placement`) governs *where a run runs*; this one governs
*what its output may do*. Without it the gate is only half a gate: a model trained on
`local-only` data can memorize it, and a published model would exfiltrate exactly what §4.2
protected. So the finetuned model entity **and every weight/export asset** inherit the
most-restrictive egress of ``{data ∪ base}`` (computed in :mod:`agora_trainer.lineage`), and:

- a `local-only`-inheriting model **MUST NOT** be registered in a cross-boundary registry, pushed
  to a cloud/Hub, or `fetch`ed across the tier boundary — the same enforcement KGP §7.2 applies to
  packs, now applied to model artifacts;
- the registry (§8) **rejects** a cross-boundary registration of a `local-only` model **and reports
  it** — never a silent drop, exactly as ``schemas/axes.ts::assertPackEgress`` rejects a pack that
  carries `local-only` records across a boundary.

The discovery registry is the agora TS service (KFT §8); this module is the trainer-side
application of the identical §5.4 rule — the honest offline stand-in for the registry's refusal,
the same way :mod:`agora_trainer.placement` stands in for SkyPilot and
:mod:`agora_trainer.resolve` for the live ``fetch:asset`` path. A live deployment registers the
bundle against the real registry, which applies this same rule; the ``boundary`` here is the
in-tier-vs-cross-boundary decision the caller supplies.
"""

from __future__ import annotations

from dataclasses import dataclass

from .egress import LOCAL_ONLY, is_local_only
from .lineage import ArtifactBundle, ModelEntity
from .validate import Problem


class RegistrationRejected(Exception):
    """A cross-boundary registration of a `local-only` artifact — refused and reported (§5.4)."""

    def __init__(self, problem: Problem) -> None:
        self.problem = problem
        super().__init__(problem.message)


@dataclass(frozen=True)
class Registered:
    """The accepted registration — the model id and every asset id the registry indexed (§8)."""

    model: str
    assets: tuple[str, ...]
    #: Whether it was registered across a trust boundary (a cross-project / cloud registry).
    across_boundary: bool


def _refuse(subject: str, egress_id: str) -> RegistrationRejected:
    return RegistrationRejected(
        Problem(
            code="egress-output",
            path="/egress",
            message=(
                f"{subject} inherits egress {LOCAL_ONLY!r} (KFT §5.4, FT-A) and MUST NOT be "
                "registered across the trust boundary, pushed to a cloud/Hub, or fetched across "
                f"the tier boundary; the registry refuses and reports it (was {egress_id!r})"
            ),
        )
    )


def assert_registrable(model: ModelEntity, *, across_boundary: bool) -> None:
    """Raise :class:`RegistrationRejected` if a `local-only` model crosses the boundary (§5.4)."""
    if across_boundary and is_local_only(model.egress):
        raise _refuse(f"model {model.id}", model.egress)


def register_bundle(bundle: ArtifactBundle, *, across_boundary: bool) -> Registered:
    """Register a run's §5 artifacts, enforcing the §5.4 output-egress inheritance (FT-A).

    The model **and every weight/export asset** must clear the boundary: all inherit the same
    class (§5.4), so a `local-only` model refuses the whole bundle. An in-tier registration
    (``across_boundary=False``) admits any class — `local-only` output stays in-tier, which is
    exactly what §5.4 permits.
    """
    assert_registrable(bundle.model, across_boundary=across_boundary)
    for asset in bundle.weights:
        if across_boundary and is_local_only(asset.egress):
            raise _refuse(f"weight asset {asset.id}", asset.egress)
    return Registered(
        model=bundle.model.id,
        assets=bundle.weight_ids,
        across_boundary=across_boundary,
    )
