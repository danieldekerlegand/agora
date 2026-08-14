"""koine's additive layer survives OTIO's own adapters (KMI §4.2 / §4.3).

``test_otio_roundtrip.py`` proves the *composition* comes back: OTIO's ``cmx_3600`` writes
an EDL and reads it again, and the clips, tracks and timing are the ones that went in. It
also records what does **not** come back — the ``metadata.koine`` block, and with it the
content-addressed KINP asset id every clip must carry (§4.2a). This module is about that
loss, with the real adapter doing the damage rather than a simulation of it:

* the id does not survive **inside** the EDL, because an EDL addresses media by path;
* the §4.3 media map is what brings it home, byte-identical — not a new id, the same hash;
* what the map cannot resolve stays unidentified and is *reported*, never guessed;
* the lineage graph and the analysis→knowledge bridge (§4.2b/c) are unaffected throughout,
  because they were never in the document — they are KGP assertions over assets.

The Rust suite (``crates/core/tests/koine_additive_layer.rs``) asserts the same layer over
a simulated cycle, and owns the lineage and analysis halves. This one is here for the leg
that needs OTIO to be real.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import translation_py

pytest.importorskip(
    "opentimelineio",
    reason="the media-timeline path needs OpenTimelineIO (KMI §4 adopts it)",
)

CORE = Path(__file__).resolve().parents[2] / "core"
FIXTURE = CORE / "fixtures" / "timeline.otio.json"

SHOT = "analyzer:asset:blake3-c3d4e5f6a1b2"


@pytest.fixture(scope="module")
def timeline_json() -> str:
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def video_only(timeline_json: str) -> str:
    """The video track alone — CMX3600 is a single-video-track format, and the engine may
    not quietly reshape a timeline to fit one."""
    document = json.loads(timeline_json)
    document["tracks"]["children"] = document["tracks"]["children"][:1]
    return json.dumps(document)


def test_clips_carry_content_addressed_asset_ids(timeline_json: str) -> None:
    """§4.2a: identity travels inside the canonical timeline, as a KINP asset id — the
    hash of the bytes — and the §4.3 media map keys on those same ids."""
    assets = translation_py.timeline_assets(timeline_json)
    assert SHOT in assets
    assert assets == sorted(assets)
    assert translation_py.timeline_unidentified(timeline_json) == []

    media_map = translation_py.timeline_media_map(timeline_json)
    assert set(media_map) == set(assets)
    assert media_map[SHOT] == "/conform/renaud-approach.mov"

    plane = translation_py.kmi_media_plane()
    assert plane["timeline_media_type"] == "application/vnd.opentimelineio+json"
    assert plane["kmi_version"] == "0.3.2"


def test_asset_identity_is_stable_across_a_real_adapter_cycle(video_only: str) -> None:
    """canonical → CMX3600 → canonical → relink, with OTIO's adapter running both
    conversions. The id that comes home is the *same* id, which is the whole point: a
    content-addressed identity that changed across a translate cycle would fork the asset,
    its lineage, and every claim made about it."""
    media_map = translation_py.timeline_media_map(video_only)
    assert translation_py.timeline_assets(video_only) == [SHOT]

    edl = translation_py.timeline_to_adapter(video_only, "cmx_3600")
    back = translation_py.timeline_from_adapter(edl, "cmx_3600")

    # The format's own edge (§4.3), through the real adapter: an EDL carries paths, not
    # namespaced metadata, so identity does not survive inside the document.
    assert translation_py.timeline_assets(back) == []
    lost = translation_py.timeline_unidentified(back)
    assert [entry["target_url"] for entry in lost] == [
        "file:///conform/renaud-approach.mov"
    ]
    assert translation_py.timeline_media_map(back) is None

    # And the map brings it home, byte for byte.
    relinked = translation_py.timeline_relink(back, media_map)
    assert translation_py.timeline_assets(relinked) == [SHOT]
    assert translation_py.timeline_unidentified(relinked) == []
    # The map rides home too (§4.2d), so the next hop is self-describing.
    assert translation_py.timeline_media_map(relinked) == media_map

    # OTIO's half is untouched by koine's repair: the composition the adapter returned is
    # the composition that was relinked.
    def clips(document: str) -> list[dict[str, object]]:
        timeline = json.loads(document)
        return [
            {"name": child["name"], "source_range": child["source_range"]}
            for track in timeline["tracks"]["children"]
            for child in track["children"]
            if child["OTIO_SCHEMA"].startswith("Clip.")
        ]

    assert clips(relinked) == clips(back)


def test_relinking_supplies_identity_and_never_invents_it(video_only: str) -> None:
    """The repair is bounded: an id already present outranks the map (§4.2a — the id is
    authoritative, the ``target_url`` advisory), and a path the map does not name is left
    unidentified rather than filled in from position or name."""
    other = "mediastore:asset:blake3-a1b2c3d4e5f6"

    # A map disagreeing with an id present in the document does not renumber the asset.
    misdirected = {other: "/conform/renaud-approach.mov"}
    assert translation_py.timeline_assets(
        translation_py.timeline_relink(video_only, misdirected)
    ) == [SHOT]

    # A map naming nothing in the timeline restores nothing — and says so.
    back = translation_py.timeline_from_adapter(
        translation_py.timeline_to_adapter(video_only, "cmx_3600"), "cmx_3600"
    )
    elsewhere = translation_py.timeline_relink(back, {other: "/archive/master.mov"})
    assert translation_py.timeline_assets(elsewhere) == []
    assert len(translation_py.timeline_unidentified(elsewhere)) == 1


def test_a_media_map_entry_must_be_a_content_addressed_asset_id(video_only: str) -> None:
    """The map is asset-id ↔ path (§4.3). A key that is a *name* is not an asset id, and
    accepting one would let a relink mint identity that no bytes back."""
    with pytest.raises(ValueError, match="content-addressed"):
        translation_py.timeline_relink(
            video_only, {"mediastore:asset:renaud-approach": "/conform/x.mov"}
        )
