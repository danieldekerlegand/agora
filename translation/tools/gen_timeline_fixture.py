#!/usr/bin/env python3
"""Emit the canonical-timeline fixture — with OTIO, so it is valid OTIO by construction.

KMI §4 makes an OpenTimelineIO ``Timeline`` the canonical composition model, so agora's
timeline fixture must be a document *OTIO itself* wrote, not one we hand-authored: a
hand-authored document is an opinion about OTIO's schema, and OTIO's reader is the only
thing entitled to hold one. (Hand-authoring is exactly how a fixture drifts — e.g. a
``Clip.2`` carrying the singular ``media_reference`` of ``Clip.1``, which OTIO's reader
rejects outright.)

What the fixture carries beyond plain OTIO is koine's additive layer (§4.2), riding
OTIO's own ``metadata`` extension point: every media reference carries its KINP ``asset``
id under ``metadata.koine``, and the timeline carries ``kmi_version`` plus the §4.3
``media_map``. A stock OTIO reader opens it unchanged.

The video track runs at a whole 24 fps on purpose: CMX3600 timecode is at an integer
rate, so a 23.976 fixture would round on the way through ``cmx_3600`` and the round-trip
test could not assert exact timing. The lossiness at each format's own edges is real
(§4.3) — the fixture just does not manufacture extra.

Usage (from anywhere)::

    uv run --with opentimelineio python translation/tools/gen_timeline_fixture.py
"""

from __future__ import annotations

from pathlib import Path

import opentimelineio as otio
from opentimelineio.opentime import RationalTime, TimeRange
from opentimelineio.schema import (
    Clip,
    ExternalReference,
    Gap,
    MissingReference,
    Timeline,
    Track,
    TrackKind,
)

FIXTURE = Path(__file__).resolve().parents[1] / "crates" / "core" / "fixtures" / "timeline.otio.json"

KMI_VERSION = "0.3.0"
VIDEO_RATE = 24.0
AUDIO_RATE = 48000.0

# The three assets the edit references, by KINP id (identity.md §7.2 — content-addressed
# over the bytes). The namespaces are KINP's illustrative placeholders.
SHOT = "analyzer:asset:blake3-c3d4e5f6a1b2"
SCORE = "mediastore:asset:blake3-b7c8d9e0f1a2"
NARRATION = "analyzer:asset:blake3-d4e5f6a1b2c3"


def external(target_url: str, asset: str, available: TimeRange) -> ExternalReference:
    """An OTIO ExternalReference: location (advisory) plus KINP identity (authoritative)."""
    reference = ExternalReference(target_url=target_url, available_range=available)
    reference.metadata["koine"] = {"asset": asset}
    return reference


def build() -> Timeline:
    timeline = Timeline(name="recap-trailer")
    timeline.global_start_time = RationalTime(0, VIDEO_RATE)

    video = Track(name="V1", kind=TrackKind.Video)
    timeline.tracks.append(video)
    video.append(
        Gap(
            name="lead-in",
            source_range=TimeRange(
                RationalTime(0, VIDEO_RATE), RationalTime(24, VIDEO_RATE)
            ),
        )
    )
    video.append(
        Clip(
            name="renaud-approach",
            media_reference=external(
                "file:///conform/renaud-approach.mov",
                SHOT,
                TimeRange(RationalTime(0, VIDEO_RATE), RationalTime(2400, VIDEO_RATE)),
            ),
            source_range=TimeRange(
                RationalTime(288, VIDEO_RATE), RationalTime(96, VIDEO_RATE)
            ),
        )
    )

    score = Track(name="A1", kind=TrackKind.Audio)
    timeline.tracks.append(score)
    score.append(
        Clip(
            name="score",
            media_reference=external(
                "file:///conform/score.wav",
                SCORE,
                TimeRange(RationalTime(0, AUDIO_RATE), RationalTime(2880000, AUDIO_RATE)),
            ),
            source_range=TimeRange(
                RationalTime(0, AUDIO_RATE), RationalTime(1440000, AUDIO_RATE)
            ),
        )
    )

    # A producer with no path to offer MUST still carry the id — on a MissingReference if
    # necessary — so an offline timeline is still resolvable in the fabric (§4.2a).
    narration_reference = MissingReference(name="narration (bytes not yet propagated)")
    narration_reference.metadata["koine"] = {"asset": NARRATION}
    narration = Track(name="A2", kind=TrackKind.Audio)
    timeline.tracks.append(narration)
    narration.append(
        Clip(
            name="narration",
            media_reference=narration_reference,
            source_range=TimeRange(
                RationalTime(0, AUDIO_RATE), RationalTime(1392000, AUDIO_RATE)
            ),
        )
    )

    timeline.metadata["koine"] = {
        "kmi_version": KMI_VERSION,
        # delta I (§4.3): asset id ↔ resolved path, so an adapter's path-addressed output
        # can be relinked on the far side instead of going "media offline".
        "media_map": {
            SHOT: "/conform/renaud-approach.mov",
            SCORE: "/conform/score.wav",
            NARRATION: "/conform/narration.wav",
        },
    }
    return timeline


def main() -> None:
    document = otio.adapters.write_to_string(build(), "otio_json")
    FIXTURE.write_text(document if document.endswith("\n") else document + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} ({otio.__version__})")


if __name__ == "__main__":
    main()
