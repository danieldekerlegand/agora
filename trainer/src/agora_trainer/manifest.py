"""The trainer's KCB capability manifest — ``koine/specs/capability-bus.md`` §2, KFT §2.

The trainer advertises the `finetune` capability: a single capability whose inputs and outputs
are **plane-typed ports** (KCB §2.1), so it spans the entity, knowledge, and media planes at
once — which is exactly what fine-tuning needs (data in one plane, a model out in another):

* inputs  — a `model`/`entity` **base-model** port, plus a `knowledge` and/or `media`
  **training-set** port (which planes depends on the modality, KFT §3.1/§4.1), plus the
  **training-records** port: a `media` port carrying the registered
  ``application/vnd.koine.dataset+jsonl`` type, which is how a *producer's* training exhaust is
  path-searchable at all (KFT §2/§4.1, FT-M) rather than mis-routed at the image/video port;
* outputs — a `model`/`entity` **finetuned-model** port, plus a `media` **weights** port whose
  media types are the registered model formats (KFT §5.3);
* cost    — metered in ``gpu-seconds`` (fine-tuning's natural unit, KFT §2/§7), so a caller can
  gate spend before invoking (KCB delta K). The static ``est_units`` here is a *nominal* figure;
  the load-bearing gate is the admission-time per-job estimate (KFT §7, FT-E — US-3).

Two choices mirror the provider-router's manifest discipline:

* **One `finetune` capability per modality.** KFT §2 lets a provider advertise several
  `finetune` capabilities distinguished by the `modality` they accept; path search (KCB §3) then
  routes a job to the one that accepts its modality. The modality rides the entity ports' `types`
  (the §5.1 model-entity `modality` refinement), so the registry can find the trainer *by
  modality* — ``find({produces:{entityType:"text-generation"}})`` — as well as by capability name.
* **No endpoint is advertised that is not served.** A manifest address is a promise a peer will
  dial directly (ADR-0001 decision 3); a dead one is worse than an absent one. This build serves
  ``/health``, the A2A agent card, this manifest, and the `finetune` ``/invoke`` +
  ``/subscribe`` task surface, and publishes exactly those. ``invoke`` also rides each
  capability's own ``endpoint``, which is what ``endpointFor`` hands a caller — so a bridge that
  discovered this trainer through the registry gets the URL it actually posts a job to, not the
  agent card. ``subscribe`` is advertised alongside it, because a run's telemetry consumer is
  rarely the connection that opened the run (KCB §4, KFT §6).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from . import KCB_VERSION, __version__
from .config import TrainerConfig
from .modality import MODALITIES, Modality
from .records import RECORDS_MEDIA_TYPE, RECORDS_SHAPE

#: Where the manifest is served, and how a crawler finds it (KCB §3, pull population).
MANIFEST_PATH = "/.well-known/kcb-manifest.json"

#: Where the trainer's A2A agent card is served — the dialable address peers connect to for
#: the `finetune` invoke / subscribe verbs (KCB §4), both served here.
AGENT_CARD_PATH = "/.well-known/agent-card.json"

#: The invocable capability name every modality shares (KFT §2). Modality distinguishes them.
CAPABILITY_NAME = "finetune"

#: The `finetune` invoke task surface (KCB §4) — where a caller POSTs a job manifest and reads
#: back the §6 training-telemetry stream.
INVOKE_PATH = "/invoke"

#: The `finetune` subscribe surface (KCB §4) — where any *other* consumer reads the same §6
#: stream for a run named by its ``job`` id, from the beginning or from a step cursor.
SUBSCRIBE_PATH = "/subscribe"

#: The KMI weight/export media types the trainer produces (KFT §5.3, koine registry media-types).
WEIGHTS_MEDIA_TYPES: tuple[str, ...] = (
    "application/vnd.koine.model+safetensors",
    "application/vnd.koine.model+gguf",
)

#: The KINP entity type of a model, before its `modality` refinement (KFT §5.1).
MODEL_ENTITY_TYPE = "model"

#: What each capability's nominal ``est_units`` is priced against — a single reference run per
#: modality, fixed so two providers' figures are comparable (the real gate is FT-E, US-3).
NOMINAL_GPU_SECONDS: dict[str, int] = {
    "text-generation": 1_800_000,
    "image-text-to-text": 1_200_000,
    "video-text-to-text": 3_600_000,
    "text-to-image": 900_000,
    "text-to-video": 5_400_000,
}

#: Human-readable statement of the reference run, published as ``cost.basis``.
COST_BASIS = "nominal single run; admission recomputes per job (KFT §7, FT-E)"

#: The cost meter for the whole capability class (KFT §2).
COST_METER = "gpu-seconds"


def base_model_port(modality: Modality) -> dict[str, Any]:
    """The base-model input — a `model` entity, refined by modality (KFT §2/§5.1)."""
    return {"plane": "entity", "types": [MODEL_ENTITY_TYPE, modality.name], "shape": "base-model"}


def finetuned_model_port(modality: Modality) -> dict[str, Any]:
    """The finetuned-model output — a new `model` entity, same modality refinement (KFT §2)."""
    return {
        "plane": "entity",
        "types": [MODEL_ENTITY_TYPE, modality.name],
        "shape": "finetuned-model",
    }


def weights_port() -> dict[str, Any]:
    """The weights output — a media port carrying the registered model formats (KFT §5.3).

    ``world_pattern: "*"`` (delta J): model weights are world-agnostic, so the port serves any
    world rather than claiming one.
    """
    return {
        "plane": "media",
        "media_types": list(WEIGHTS_MEDIA_TYPES),
        "world_pattern": "*",
        "shape": "weights",
    }


def training_records_port() -> dict[str, Any]:
    """The ``dataset.records[]`` input — a producer's training exhaust (KFT §2/§4.1, FT-M).

    Its own port, on every modality: a training-record JSONL is neither a KGP pack nor
    image/video/audio bytes, so without this the exhaust has no path-searchable arrival point
    and the FT-I per-sample join surface would be unroutable.
    """
    return {
        "plane": "media",
        "media_types": [RECORDS_MEDIA_TYPE],
        "world_pattern": "*",
        "shape": RECORDS_SHAPE,
    }


def training_set_ports(modality: Modality) -> list[dict[str, Any]]:
    """The training-set inputs — knowledge and/or media, by modality (KFT §3.1/§4.1)."""
    ports: list[dict[str, Any]] = []
    if modality.consumes_knowledge:
        ports.append({"plane": "knowledge", "dialect": "grounding-only", "shape": "training-set"})
    if modality.consumes_media:
        ports.append(
            {"plane": "media", "media_types": list(modality.media_types), "shape": "training-set"}
        )
    ports.append(training_records_port())
    return ports


def capability(modality: Modality, base_url: str) -> dict[str, Any]:
    """The `finetune` capability for one modality (KFT §2)."""
    return {
        "name": CAPABILITY_NAME,
        # The capability's own dialable endpoint (KCB §2) — `endpointFor` prefers it, so a
        # caller that found this trainer by capability gets the invoke URL, not the agent card.
        "endpoint": f"{base_url}{INVOKE_PATH}",
        # Not part of KCB's capability shape, but read straight through the manifest narrower —
        # they let the registry (US-5) distinguish this general provider's broad surface from a
        # specialized provider's narrower one (KFT §3.1/§8, FT-K).
        "modality": modality.name,
        "methods": list(modality.methods),
        "inputs": [base_model_port(modality), *training_set_ports(modality)],
        "outputs": [finetuned_model_port(modality), weights_port()],
        "cost": {
            "tier": "local",
            "meter": COST_METER,
            "est_units": NOMINAL_GPU_SECONDS[modality.name],
            "basis": COST_BASIS,
            "unpriced": False,
        },
    }


def capability_manifest(config: TrainerConfig) -> dict[str, Any]:
    """The full KCB manifest for ``config``. Never raises."""
    base = config.base_url.rstrip("/")
    return {
        "kcb_version": KCB_VERSION,
        "identity": config.identity,
        "version": __version__,
        "endpoints": {
            "a2a": f"{base}{AGENT_CARD_PATH}",
            "invoke": f"{base}{INVOKE_PATH}",
            "subscribe": f"{base}{SUBSCRIBE_PATH}",
            "health": f"{base}/health",
            "manifest": f"{base}{MANIFEST_PATH}",
        },
        "produces": _unique(
            _each(MODALITIES, finetuned_model_port) + [weights_port()],
        ),
        "consumes": _unique(
            _each(MODALITIES, base_model_port)
            + [port for m in MODALITIES for port in training_set_ports(m)],
        ),
        "capabilities": [capability(m, base) for m in MODALITIES],
        "auth": {
            "scheme": "capability-token",
            # KFT §7: `invoke:finetune` per-world, per-capability, carrying a `budget_units`
            # ceiling (KCB delta K) that admission enforces before provisioning (US-3).
            "grants_required": [f"invoke:{CAPABILITY_NAME}"],
            "budget_units": {
                "supported": True,
                "currency": "budget_units",
                "meter": COST_METER,
            },
        },
    }


def agent_card(config: TrainerConfig) -> dict[str, Any]:
    """A minimal A2A agent card — identity plus a pointer to the KCB manifest (KCB §3)."""
    base = config.base_url.rstrip("/")
    return {
        "name": "agora-trainer",
        "identity": config.identity,
        "version": __version__,
        "kcb_manifest": f"{base}{MANIFEST_PATH}",
    }


def _each(modalities: Iterable[Modality], build: Any) -> list[dict[str, Any]]:
    return [build(m) for m in modalities]


def _unique(ports: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dedupe ports by value, keeping first-seen order (modalities share some ports)."""
    seen: list[dict[str, Any]] = []
    for port in ports:
        if port not in seen:
            seen.append(port)
    return seen
