"""Model, weight & export artifacts — identity, lineage & inheritance (KFT §5).

Fine-tuning produces artifacts on two planes; KFT §5 fixes how they are identified and linked so
the whole training lineage is queryable on the fabric. This module is the engine-agnostic
authority for all of it — every adapter (:mod:`agora_trainer.llama_factory`,
:mod:`agora_trainer.diffusers`) mints through the *same* helpers here, so ids and lineage cannot
drift between engines:

* **§5.1 Models are KINP entities.** The finetuned model is a `model` entity (with a `modality`
  refinement), linked to its base with ``based_on`` / ``derived_from`` (KINP §4). A re-train mints
  a *new* entity linked to its predecessor with ``retrains`` / ``supersedes`` (never an id
  collision).
* **§5.2 The run is a PROV activity.** The ``job`` id is the activity; its record carries
  ``used`` (base + data) / ``generated`` (model + weights) + ``seed`` + ``config_hash`` — the
  reproducibility anchor lives on the RUN, because GPU nondeterminism means a model id **cannot**
  be content-addressed (FT-C). The model id is therefore **minted** deterministically from that
  anchor: the same run mints the same id, a new ``job`` mints a fresh one.
* **§5.3 Weights & exports are KMI assets.** Each is a byte-hash asset with a registered
  ``application/vnd.koine.model+…`` media type; the export matrix *is* the KMI lineage graph —
  the adapter is ``media:derived_from`` the base, and each export is ``media:variant_of`` the
  primary weights.
* **§5.4 Output egress & license inheritance (NORMATIVE, FT-A).** The model entity **and every
  weight/export asset** inherit the *most-restrictive* egress and the *union* license of
  ``{training data ∪ base}`` — so where §4.2 governs where a run *runs*, §5.4 governs what its
  output may *do*. Enforcement of the inherited class at registration is
  :mod:`agora_trainer.registration`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .resolve import RecordFacts, ResolvedInputs

#: The KINP namespace + kind the trainer mints finetuned models under (KFT §5.1).
MODEL_NAMESPACE = "agora:model:"
#: The provider org recorded as the PROV activity's ``agent`` (§5.2; signed in US-6).
TRAINING_AGENT = "agora:org:trainer"

#: The primary weight artifact every run produces — the LoRA/adapter weights (§5.3 table row 1).
PRIMARY_ARTIFACT = "safetensors-adapter"

#: The §5.3 export matrix (koine ``registry/media-types.tsv``): an export token's normalized head →
#: its KMI media type + a role label. ``media:derived_from`` weights link to the base; the
#: quantized/converted exports are ``media:variant_of`` the primary weights (a byte-encoding of the
#: same model). An unknown token maps to a generic model media type rather than being dropped.
_EXPORT_MATRIX: dict[str, tuple[str, str]] = {
    "safetensors-adapter": ("application/vnd.koine.model+safetensors", "adapter"),
    "safetensors-merged": ("application/vnd.koine.model+safetensors", "merged"),
    "safetensors": ("application/vnd.koine.model+safetensors", "adapter"),
    "gguf": ("application/vnd.koine.model+gguf", "gguf"),
    "onnx": ("application/vnd.koine.model+onnx", "onnx"),
    "coreml": ("application/vnd.koine.model+coreml", "coreml"),
    "tflite": ("application/vnd.koine.model+tflite", "tflite"),
}

#: The KMI relations the §5.3 lineage graph is built from (koine ``registry/relations/media.tsv``).
MEDIA_DERIVED_FROM = "media:derived_from"
MEDIA_VARIANT_OF = "media:variant_of"

#: The KINP lifecycle relations a finetuned model carries (koine ``registry/relations.tsv``).
BASED_ON = "based_on"
DERIVED_FROM = "derived_from"
RETRAINS = "retrains"
SUPERSEDES = "supersedes"


@dataclass(frozen=True)
class LineageLink:
    """One directed lineage edge — a registered relation + the node it points at (KINP §4)."""

    relation: str
    target: str

    def describe(self) -> dict[str, str]:
        return {"relation": self.relation, "target": self.target}


@dataclass(frozen=True)
class WeightAsset:
    """A §5.3 weight/export KMI asset — id, media type, lineage, and inherited envelope (§5.4)."""

    id: str
    media_type: str
    role: str
    lineage: tuple[LineageLink, ...] = ()
    #: The inherited egress class (§5.4/FT-A) — most-restrictive over ``{data ∪ base}``.
    egress: str = ""
    #: The inherited union license (§5.4) across ``{data ∪ base}``.
    license: tuple[str, ...] = ()

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "media_type": self.media_type,
            "role": self.role,
            "lineage": [link.describe() for link in self.lineage],
            "egress": self.egress,
            "license": list(self.license),
        }


@dataclass(frozen=True)
class RunActivity:
    """The §5.2 PROV run activity — the reproducibility anchor (FT-C), fully attributable."""

    activity: str
    agent: str
    used: tuple[str, ...]
    generated: tuple[str, ...]
    seed: Any | None = None
    config_hash: str | None = None
    spent_units: float | None = None

    def describe(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "activity": self.activity,
            "agent": self.agent,
            "used": list(self.used),
            "generated": list(self.generated),
        }
        if self.seed is not None:
            body["seed"] = self.seed
        if self.config_hash is not None:
            body["config_hash"] = self.config_hash
        if self.spent_units is not None:
            body["spent_units"] = self.spent_units
        return body


@dataclass(frozen=True)
class ModelEntity:
    """The §5.1 finetuned `model` KINP entity — minted id, lineage, inherited envelope (§5.4)."""

    id: str
    modality: str
    based_on: str
    derived_from: str
    #: The inherited egress class (§5.4/FT-A) that the registry enforces at registration.
    egress: str
    #: The inherited union license (§5.4).
    license: tuple[str, ...] = ()
    #: A re-train links to the model it replaces (KINP §4; §5.2) — ``None`` for a first train.
    retrains: str | None = None
    supersedes: str | None = None
    kft_version: str | None = None

    def links(self) -> tuple[LineageLink, ...]:
        """Every lineage edge this entity asserts — base linkage plus any re-train linkage."""
        edges = [
            LineageLink(BASED_ON, self.based_on),
            LineageLink(DERIVED_FROM, self.derived_from),
        ]
        if self.retrains is not None:
            edges.append(LineageLink(RETRAINS, self.retrains))
        if self.supersedes is not None:
            edges.append(LineageLink(SUPERSEDES, self.supersedes))
        return tuple(edges)

    def describe(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "id": self.id,
            "type": ["model", self.modality],
            "egress": self.egress,
            "license": list(self.license),
            "lineage": [link.describe() for link in self.links()],
        }
        if self.kft_version is not None:
            body["kft_version"] = self.kft_version
        return body


@dataclass(frozen=True)
class ArtifactBundle:
    """The complete §5 output of a run — the model entity, its PROV activity, its weight assets."""

    model: ModelEntity
    activity: RunActivity
    weights: tuple[WeightAsset, ...] = field(default_factory=tuple)

    @property
    def weight_ids(self) -> tuple[str, ...]:
        return tuple(w.id for w in self.weights)

    def describe(self) -> dict[str, Any]:
        """The §5.3 export matrix as a caller reads it — the model, the run, every asset.

        This *is* the KMI lineage graph (§5.3): each entry carries its registered media type and
        its ``media:derived_from`` / ``media:variant_of`` link, plus the §5.4 egress + union
        license it inherited, so a consumer can decide what it may `fetch` without re-deriving
        the corpus. The §5.2 activity rides along because the export matrix is only meaningful
        against the run that generated it (FT-C).
        """
        return {
            "model": self.model.describe(),
            "activity": self.activity.describe(),
            "exports": [asset.describe() for asset in self.weights],
        }


# --- minting helpers (shared by every engine so ids never drift) -----------------------------


def run_anchor(job: dict[str, Any]) -> str:
    """The §5.2 reproducibility-anchor string the outputs are minted from (FT-C)."""
    return "\x00".join(
        (
            str(job.get("job", "")),
            str(job.get("seed", "")),
            str(job.get("config_hash", "")),
            str(job.get("base_model", "")),
            str(job.get("modality", "")),
            str(job.get("method", "")),
        )
    )


def mint_model_id(job: dict[str, Any]) -> str:
    """Mint the finetuned-model KINP id from the run anchor — deterministic, not content-hashed."""
    digest = hashlib.sha256(run_anchor(job).encode()).hexdigest()[:16]
    return f"{MODEL_NAMESPACE}ft-{digest}"


def mint_asset_id(model: str, artifact: str) -> str:
    """Mint a weight/export KMI asset id (§5.3) — content-addressed by ``model + artifact``."""
    digest = hashlib.sha256(f"{model}\x00{artifact}".encode()).hexdigest()
    return f"sha256:{digest}"


def planned_artifacts(job: dict[str, Any]) -> tuple[str, ...]:
    """The primary adapter plus each requested export, de-duplicated, order-stable (§5.3)."""
    artifacts = [PRIMARY_ARTIFACT]
    for export in job.get("export", ()):
        token = str(export)
        if token not in artifacts:
            artifacts.append(token)
    return tuple(artifacts)


def _matrix_entry(artifact: str) -> tuple[str, str]:
    """The (media_type, role) for an export token; its head before ``:`` keys the §5.3 matrix."""
    head = artifact.split(":", 1)[0]
    if artifact in _EXPORT_MATRIX:
        return _EXPORT_MATRIX[artifact]
    if head in _EXPORT_MATRIX:
        return _EXPORT_MATRIX[head]
    return (f"application/vnd.koine.model+{head}", head)


def union_license(resolved: ResolvedInputs) -> tuple[str, ...]:
    """The §5.4 union license across ``{data ∪ base}`` — sorted, de-duplicated, ``None`` dropped.

    A downstream consumer admits or rejects the *model* with the same class-based allowlist it
    applies to a pack (KGP §7.1): a non-commercial base makes the model non-commercial regardless
    of the data, because its class is in this union.
    """
    licenses = {r.license for r in resolved.all_inputs if r.license is not None and r.license != ""}
    return tuple(sorted(licenses))


def _used_refs(resolved: ResolvedInputs) -> tuple[str, ...]:
    """The §5.2 ``used`` set — the base entity plus every training-data ref, order-stable."""
    refs: list[str] = []
    for facts in (resolved.base, *resolved.data):
        if facts.ref and facts.ref not in refs:
            refs.append(facts.ref)
    return tuple(refs)


def mint_artifacts(
    job: dict[str, Any],
    resolved: ResolvedInputs,
    *,
    predecessor: str | None = None,
    spent_units: float | None = None,
    kft_version: str | None = None,
) -> ArtifactBundle:
    """Build the run's complete §5 artifact bundle — the single authority every engine calls.

    The model id + weight asset ids are minted from the run anchor (§5.2, FT-C); the §5.3 lineage
    graph links the adapter to the base and each export to the primary weights; the model entity
    and **every** weight asset inherit the most-restrictive egress + union license of
    ``{data ∪ base}`` (§5.4, FT-A). ``predecessor`` (supplied by the provider from its registry
    lookup, an injected fact) links a re-train via ``retrains`` / ``supersedes``.
    """
    base_ref = resolved.base.ref
    egress = resolved.effective_egress
    licenses = union_license(resolved)
    model_id = mint_model_id(job)

    artifacts = planned_artifacts(job)
    primary_token = artifacts[0]
    primary_id = mint_asset_id(model_id, primary_token)

    weights: list[WeightAsset] = []
    for index, token in enumerate(artifacts):
        media_type, role = _matrix_entry(token)
        asset_id = mint_asset_id(model_id, token)
        if index == 0:
            # The primary weights derive from the base model (§5.3 row 1).
            lineage = (LineageLink(MEDIA_DERIVED_FROM, base_ref),)
        else:
            # Each export is a byte-encoding variant of the primary weights (§5.3).
            lineage = (LineageLink(MEDIA_VARIANT_OF, primary_id),)
        weights.append(
            WeightAsset(
                id=asset_id,
                media_type=media_type,
                role=role,
                lineage=lineage,
                egress=egress,
                license=licenses,
            )
        )

    model = ModelEntity(
        id=model_id,
        modality=str(job.get("modality", "")),
        based_on=base_ref,
        derived_from=base_ref,
        egress=egress,
        license=licenses,
        retrains=predecessor,
        supersedes=predecessor,
        kft_version=kft_version,
    )
    activity = RunActivity(
        activity=str(job.get("job", "")),
        agent=TRAINING_AGENT,
        used=_used_refs(resolved),
        generated=(model_id, *(w.id for w in weights)),
        seed=job.get("seed"),
        config_hash=job.get("config_hash"),
        spent_units=spent_units,
    )
    return ArtifactBundle(model=model, activity=activity, weights=tuple(weights))


def facts_of(ref: str, *, egress: str = "", license: str | None = None) -> RecordFacts:
    """Small constructor used by tests/deployments to describe one input's §5.4-relevant facts."""
    return RecordFacts(ref=ref, egress=egress or "exportable", license=license)
