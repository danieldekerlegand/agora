"""The KFT §3.1 modality × method vocabulary this **general** provider serves.

`modality` is a closed vocabulary (KFT §3.1) shared with the model-entity `type` refinement
(§5) and the capability's port types (§2). Each modality names the data planes its training
set travels on — knowledge (KGP), media (KMI), or both — which is what makes a single
`finetune` capability span planes (data in one plane, model out in another).

This module declares only the **general** surface agora advertises. A *specialized* provider
(e.g. a caller's own TRL+PEFT path) advertises its own, narrower capability on the bus; the
registry routes between them (KFT §8/§9, FT-K) — that discrimination is US-5's concern, and it
works precisely because this surface is the broad, general one.

`modality` and `method` are **not** independent: an incompatible combination (e.g. `dpo` on
`text-to-image`) MUST be rejected at admission with a report, before any compute is committed
(KFT §3.1, FT-F). That admission check lands in US-2; this module is the source of truth it
consults.
"""

from __future__ import annotations

from enum import StrEnum


class DataPlane(StrEnum):
    """A training-set data plane a modality consumes (KFT §4.1)."""

    KNOWLEDGE = "knowledge"
    MEDIA = "media"


class Modality:
    """One entry in the KFT §3.1 modality vocabulary — what it consumes and how it trains."""

    __slots__ = ("name", "planes", "media_types", "methods")

    def __init__(
        self,
        name: str,
        *,
        planes: tuple[DataPlane, ...],
        media_types: tuple[str, ...],
        methods: tuple[str, ...],
    ) -> None:
        self.name = name
        #: The data planes this modality's training set rides on (KFT §4.1).
        self.planes = planes
        #: The KMI media-type globs its media training set carries (empty for text-only).
        self.media_types = media_types
        #: The `method`s this general provider supports for the modality (KFT §3.1 table).
        self.methods = methods

    @property
    def consumes_knowledge(self) -> bool:
        return DataPlane.KNOWLEDGE in self.planes

    @property
    def consumes_media(self) -> bool:
        return DataPlane.MEDIA in self.planes


#: The full modality catalog, in KFT §3.1 table order. The general trainer serves every row;
#: the engine ladder (LLaMA-Factory / Unsloth / Axolotl / diffusers) that actually runs each is
#: producer-internal (KFT §9) and lands in US-2 / US-4.
MODALITIES: tuple[Modality, ...] = (
    Modality(
        "text-generation",
        planes=(DataPlane.KNOWLEDGE,),
        media_types=(),
        methods=("sft", "lora", "qlora", "full", "dpo"),
    ),
    Modality(
        "image-text-to-text",
        planes=(DataPlane.KNOWLEDGE, DataPlane.MEDIA),
        media_types=("image/*",),
        methods=("lora", "qlora"),
    ),
    Modality(
        "video-text-to-text",
        planes=(DataPlane.KNOWLEDGE, DataPlane.MEDIA),
        media_types=("video/*",),
        methods=("lora", "qlora"),
    ),
    Modality(
        "text-to-image",
        planes=(DataPlane.MEDIA,),
        media_types=("image/*",),
        methods=("lora", "full"),
    ),
    Modality(
        "text-to-video",
        planes=(DataPlane.MEDIA,),
        media_types=("video/*",),
        methods=("lora",),
    ),
)

#: Modality name → its record, for the admission validators (FT-F) and the manifest.
BY_NAME: dict[str, Modality] = {m.name: m for m in MODALITIES}

#: Every `method` token any modality accepts — the closed method vocabulary (KFT §3.1).
METHODS: tuple[str, ...] = ("sft", "lora", "qlora", "full", "dpo")


def supports(modality: str, method: str) -> bool:
    """True when this general provider serves ``method`` for ``modality`` (KFT §3.1, FT-F).

    An unknown modality is unsupported rather than an error here — admission (US-2) turns the
    ``False`` into the structured rejection report.
    """
    record = BY_NAME.get(modality)
    return record is not None and method in record.methods
