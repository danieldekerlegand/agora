"""The KFT dataset bridge — a producer's training exhaust becomes a gated finetune job.

This is the data-plane bridge for the training plane, the sibling of the KGP knowledge bridge in
``knowledge/``: an application emits *training exhaust* (accepted edits, generations, preference
pairs, QA labels) through a thin adapter (koine ADR-0008), and this is the generic commons path
that turns it into a real, admitted, routed finetune run. It is agnostic to **which** producer
emitted it — nothing here knows a mapping from anybody's local records onto koine shapes; what
arrives is already a by-reference KFT dataset or it is refused.

Three things happen, in this order, and none of them may be skipped:

1. **Admission** (:mod:`agora_trainer.admission`) — the full KFT §4 gate over the *referenced*
   corpus: one ``dataset-jsonl-header`` per record file, egress read from the header and never
   inferred from the trust tier (FT-N), the §4.2 effective class over ``{data ∪ base}`` (FT-B),
   the §4.3 union license, placement, and the §7 spend estimate sized from ``recordCount``
   (FT-P). **No byte of training data moves before this passes.**

2. **Selection** (KFT §8/FT-K) — the registry, not this module, decides *which* `finetune`
   provider gets the job: a caller's own **specialized** provider is preferred over the general
   trainer, ties break on cost, and an unbroken tie is surfaced rather than settled silently. The
   bridge consumes that verdict through the :data:`Directory` seam, so agora has exactly one
   implementation of the FT-K precedence (``registry/src/select.ts``, served at
   ``POST /finetune/select``) rather than a second one in Python that could drift from it.

3. **The envelope check, then a direct dial.** Selection is discovery, so what comes back is an
   *address*: the bridge dials the winner directly (ADR-0001 decision 3 — the registry never
   relays). Before it does, it applies the one rule the registry cannot: a `local-only` run
   (§4.2) may not be handed to a provider outside the originating trust boundary. That is the
   §4.2 clause applied to *provider* choice rather than to compute class — shipping the job to a
   cross-boundary trainer is the same breach as renting it a GPU — so an over-envelope selection
   is **refused with a report**, never downgraded and never quietly re-pinned.

Every refusal is a :class:`~agora_trainer.validate.Report` whose problems each name one clause,
so a producer gets a reason it can act on: ``header-missing`` / ``license-missing`` /
``records-inlined`` (§4.1), ``egress-cross-boundary`` (§4.2), ``license-refused`` (§4.3),
``budget`` (§7), ``no-provider`` / ``provider-tie`` (FT-K), ``provider-egress`` (§4.2 applied to
the provider).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from .admission import AdmissionPlan, admit
from .egress import is_local_only
from .grant import UNGATED, Grant
from .licensing import DEFAULT_POLICY, LicensePolicy
from .records import FetchedRecords, verify_fetched
from .resolve import Resolver, default_resolver
from .validate import Problem, Report, Status

#: The KCB capability every candidate advertises (KFT §2).
CAPABILITY = "finetune"

#: The KCB cost tiers (delta K) that mean "runs inside the originating trust boundary". A
#: provider advertising ``local`` runs on the caller's own hardware; ``paid`` — a rented GPU, a
#: managed training API — is by construction across the boundary. This is the best signal the
#: ratified manifest shape carries today; a deployment whose topology says otherwise supplies its
#: own :data:`Directory` and sets :attr:`ProviderOffer.in_tier` itself rather than editing this.
IN_TIER_COST_TIERS: frozenset[str] = frozenset({"local"})


@dataclass(frozen=True)
class ProviderOffer:
    """One `finetune` provider the registry matched — an **address**, never a route."""

    #: The provider's KINP identity (KCB §3).
    identity: str
    #: Where the bridge dials it directly. Empty means the registry indexed no `invoke` endpoint.
    address: str
    #: True when the provider runs inside the originating trust boundary (see
    #: :data:`IN_TIER_COST_TIERS`) and MAY therefore hold a `local-only` corpus (KFT §4.2).
    in_tier: bool = False
    #: The advertised cost tier this was read from — reported so a refusal can quote it.
    cost_tier: str = ""
    #: The projected ``gpu-seconds`` of the capability that matched, when the registry priced it.
    est_units: float | None = None


@dataclass(frozen=True)
class Selection:
    """The registry's FT-K verdict, as the bridge consumes it (KFT §8)."""

    #: ``selected`` | ``none`` | ``tie`` — the registry's own outcome vocabulary.
    outcome: str
    #: The winner, when ``outcome`` is ``selected``.
    provider: ProviderOffer | None = None
    #: Why it won — ``explicit`` | ``sole`` | ``specialized`` | ``cheaper``.
    reason: str | None = None
    #: The equally-specialized, equally-priced candidates an unbroken tie surfaces (FT-K).
    candidates: tuple[ProviderOffer, ...] = ()


#: Ask the registry which provider gets this job. The argument is the FT-K job spec
#: (``modality`` / ``method`` / an optional explicit ``provider``).
Directory = Callable[[dict[str, Any]], Selection]

#: Dial an admitted job at the selected provider's address (KCB §4 `invoke`). Returns whatever
#: the provider answered — the bridge does not interpret a provider's run, only its acceptance.
Dispatch = Callable[[ProviderOffer, dict[str, Any], Grant], dict[str, Any]]

#: Optionally fetch the referenced record files so their inline headers can be verified against
#: the bytes (§4.1) and their declared counts re-checked (FT-P). Absent — the default — means
#: this build performs no `fetch:asset`, exactly as :func:`~agora_trainer.resolve.default_resolver`
#: is honest about what it cannot fetch.
RecordFetch = Callable[[dict[str, Any]], Mapping[str, FetchedRecords]]


@dataclass(frozen=True)
class Submission:
    """What the bridge did with one producer submission — admitted and routed, or why not."""

    report: Report
    #: The resolved §4 plan, when the job was admitted.
    plan: AdmissionPlan | None = None
    #: The provider the job was dialed at (KFT §8/FT-K).
    provider: ProviderOffer | None = None
    #: Why that provider won.
    reason: str | None = None
    #: The provider's answer to the `invoke`.
    accepted: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.report.ok

    def describe(self) -> dict[str, Any]:
        """The wire form — the producer's receipt, or its graded refusal."""
        body: dict[str, Any] = dict(self.report.describe())
        if self.plan is not None:
            body["plan"] = {
                "effective_egress": self.plan.effective_egress,
                "union_license": self.plan.union_license,
                "cardinality": self.plan.cardinality,
                "estimate_units": self.plan.estimate_units,
                "placement": {
                    "tier": self.plan.placement.tier,
                    "backend": self.plan.placement.backend,
                    "compute_class": self.plan.placement.compute_class,
                },
            }
        if self.provider is not None:
            body["provider"] = {
                "identity": self.provider.identity,
                "address": self.provider.address,
                "in_tier": self.provider.in_tier,
                "reason": self.reason,
            }
        if self.accepted:
            body["accepted"] = self.accepted
        return body


def submit(
    job: dict[str, Any],
    *,
    grant: Grant = UNGATED,
    resolver: Resolver = default_resolver,
    licenses: LicensePolicy = DEFAULT_POLICY,
    directory: Directory,
    dispatch: Dispatch,
    fetch: RecordFetch | None = None,
    provider: str | None = None,
) -> Submission:
    """Admit a producer's by-reference dataset, route it (FT-K), and dial the winner.

    ``provider`` is KFT §8's "a job MAY name a target provider explicitly". It is a *call*
    argument rather than a job field because the ratified `finetune-job.schema.json` has no such
    property and closes the manifest (``additionalProperties: false``) — putting it in the body
    would make every targeted job schema-invalid. Naming the target is the caller's routing
    preference, not part of what it is asking to have trained.
    """
    admission = admit(job, grant=grant, resolver=resolver, licenses=licenses)
    if admission.plan is None:
        return Submission(report=admission.report)
    plan = admission.plan

    if fetch is not None:
        # The inline headers were a claim made to skip the fetch (§4.1). Now that the bytes are
        # in hand, the claim is checked — in the safe direction, before the run starts.
        mismatched = verify_fetched(job, fetch(job))
        if mismatched:
            return Submission(report=Report(Status.INVALID, tuple(mismatched)))

    selection = directory(
        {
            "capability": CAPABILITY,
            "modality": job.get("modality"),
            "method": job.get("method"),
            **({"provider": provider} if provider else {}),
        }
    )
    routed = _route(selection, plan)
    if isinstance(routed, Problem):
        return Submission(report=Report(Status.INVALID, (routed,)), plan=plan)

    return Submission(
        report=admission.report,
        plan=plan,
        provider=routed,
        reason=selection.reason,
        accepted=dispatch(routed, job, grant),
    )


def _route(selection: Selection, plan: AdmissionPlan) -> ProviderOffer | Problem:
    """Turn the registry's FT-K verdict into a dialable provider, or the reason there is none."""
    if selection.outcome == "tie":
        named = ", ".join(offer.identity for offer in selection.candidates)
        return Problem(
            code="provider-tie",
            path="/",
            message=(
                f"{len(selection.candidates)} `finetune` providers are equally specialized and "
                f"equally priced for this job ({named}); KFT §8/FT-K surfaces an unbroken tie to "
                "the caller rather than resolving it silently — name one in `provider`"
            ),
        )
    provider = selection.provider
    if selection.outcome != "selected" or provider is None:
        return Problem(
            code="no-provider",
            path="/modality",
            message=(
                "no registered `finetune` provider serves this job's modality × method "
                "(KFT §8); the registry indexes addresses, so an unserved job is a discovery "
                "failure rather than a run that waits"
            ),
        )
    if not provider.address:
        return Problem(
            code="no-address",
            path="/",
            message=(
                f"provider {provider.identity!r} matched but advertises no invoke endpoint; a "
                "peer is dialed directly (ADR-0001 decision 3) and the registry never relays, so "
                "there is nothing to dial"
            ),
        )
    # §4.2 applied to the *provider*: handing a local-only corpus to a cross-boundary trainer is
    # the same breach as renting it a cloud GPU. Refused, never downgraded, never re-pinned.
    if is_local_only(plan.effective_egress) and not provider.in_tier:
        return Problem(
            code="provider-egress",
            path="/dataset",
            message=(
                f"run is local-only (KFT §4.2, FT-B) but the selected provider "
                f"{provider.identity!r} advertises cost tier {provider.cost_tier or 'unknown'!r}, "
                "outside the originating trust boundary; the training data, the base weights and "
                "the job MUST NOT cross it, so the selection is refused with a report"
            ),
        )
    return provider


# --- the seams' default implementations ---------------------------------------------------------


def self_directory(identity: str, address: str) -> Directory:
    """The offline stand-in :data:`Directory` — this trainer as the sole candidate (KFT §9).

    Honest about what it can know with no registry configured: a deployment that indexes nothing
    has exactly one `finetune` provider, and this is it. It never fabricates a specialized peer,
    and it reports ``sole`` rather than ``specialized`` so a receipt does not claim a preference
    that no FT-K comparison was made. Point ``AGORA_TRAINER_REGISTRY_URL`` at a registry and
    :func:`registry_directory` takes over, with the real multi-provider precedence.
    """
    offer = ProviderOffer(
        identity=identity, address=address, in_tier=True, cost_tier="local", est_units=None
    )

    def _select(_spec: dict[str, Any]) -> Selection:
        return Selection(outcome="selected", provider=offer, reason="sole")

    return _select


def registry_directory(
    base_url: str, *, client: httpx.Client | None = None, timeout: float = 5.0
) -> Directory:
    """A :data:`Directory` backed by the real registry's ``POST /finetune/select`` (KFT §8).

    The registry owns the FT-K precedence; this only carries the question there and reads the
    answer back, so the specialized-then-cheaper-then-surface-the-tie rule has one home.
    """
    endpoint = f"{base_url.rstrip('/')}/finetune/select"

    def _select(spec: dict[str, Any]) -> Selection:
        payload = {key: value for key, value in spec.items() if value is not None}
        if client is not None:
            response = client.post(endpoint, json=payload, timeout=timeout)
        else:
            response = httpx.post(endpoint, json=payload, timeout=timeout)
        response.raise_for_status()
        return selection_from(response.json())

    return _select


def selection_from(payload: Any) -> Selection:
    """Read the registry's ``ProviderSelection`` JSON — defensively, it crossed a wire."""
    if not isinstance(payload, Mapping):
        return Selection(outcome="none")
    outcome = str(payload.get("outcome", "none"))
    provider = payload.get("provider")
    candidates = payload.get("candidates")
    return Selection(
        outcome=outcome,
        provider=offer_from(provider) if isinstance(provider, Mapping) else None,
        reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None,
        candidates=tuple(
            offer_from(item)
            for item in (candidates if isinstance(candidates, list) else [])
            if isinstance(item, Mapping)
        ),
    )


def offer_from(match: Mapping[str, Any]) -> ProviderOffer:
    """Project a registry ``Match`` onto a :class:`ProviderOffer` — address + trust boundary.

    The address is the matched capability's own ``endpoint`` (what a peer dials for `invoke`),
    falling back to the provider's advertised address. The boundary is read from the matched
    capability's KCB cost tier — see :data:`IN_TIER_COST_TIERS` for why, and its limits.
    """
    capabilities = match.get("capabilities")
    matched = _first_finetune(capabilities if isinstance(capabilities, list) else [])
    address = str(matched.get("endpoint") or "") if matched else ""
    if not address:
        address = _address_of(match.get("address"))
    cost_tier = str(matched.get("tier") or "") if matched else ""
    est = match.get("estUnits")
    return ProviderOffer(
        identity=str(match.get("identity", "")),
        address=address,
        in_tier=cost_tier in IN_TIER_COST_TIERS,
        cost_tier=cost_tier,
        est_units=_units(est),
    )


def http_dispatch(*, client: httpx.Client | None = None, timeout: float = 30.0) -> Dispatch:
    """The default :data:`Dispatch` — `invoke` the winner at its own address (KCB §4).

    A direct dial, by construction: the address came from discovery and nothing proxies it. The
    §7 ceiling rides the same ``X-Agora-Budget-Units`` header the trainer's own ``/invoke``
    reads, so a provider re-runs the spend gate against the grant rather than trusting ours.
    """

    def _dispatch(provider: ProviderOffer, job: dict[str, Any], grant: Grant) -> dict[str, Any]:
        headers = (
            {"X-Agora-Budget-Units": str(grant.budget_units)}
            if grant.budget_units is not None
            else {}
        )
        poster = client.post if client is not None else httpx.post
        response = poster(provider.address, json=job, headers=headers, timeout=timeout)
        return {
            "provider": provider.identity,
            "status": response.status_code,
            "job": job.get("job"),
        }

    return _dispatch


def _units(value: Any) -> float | None:
    """A registry cost projection, read defensively — a bool is not a price."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _first_finetune(capabilities: list[Any]) -> Mapping[str, Any] | None:
    for capability in capabilities:
        if isinstance(capability, Mapping) and capability.get("name") == CAPABILITY:
            return capability
    return None


def _address_of(address: Any) -> str:
    if isinstance(address, Mapping):
        endpoints = address.get("endpoints")
        if isinstance(endpoints, Mapping):
            for key in ("invoke", "a2a", "mcp"):
                value = endpoints.get(key)
                if isinstance(value, str) and value:
                    return value
    return ""
