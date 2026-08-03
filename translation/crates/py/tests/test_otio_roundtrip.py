"""The media-timeline path is OTIO's, end to end (KMI §4 / koine ADR-0005).

``translation_py`` is where the engine reaches OpenTimelineIO: OTIO is a C++ core with a
Python binding and no usable Rust one (the crates.io ``opentimelineio`` is an
explicitly-marked placeholder), so the timeline path runs OTIO's own reader, writer, and
adapters in this interpreter. These tests assert that, and that a timeline survives the
trip.

Two round trips, because they prove different things:

* **canonical → canonical** (``otio_json``): the KMI canonical form, in and back out
  through OTIO's own serializer, with clips, tracks and timing identical. This is the
  fidelity the spec requires of the canonical path — no loss at all.
* **canonical → CMX3600 → canonical** (``cmx_3600``): NLE interchange, run entirely by
  OTIO's adapter. Because OTIO's adapters are bidirectional, an edit that leaves the
  fabric comes back — lossily at the *format's* own edges (§4.3), which is why the
  assertions below name exactly what CMX3600 models and what it does not.

The fixture is a document OTIO itself wrote (``tools/gen_timeline_fixture.py``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import translation_py

otio = pytest.importorskip(
    "opentimelineio",
    reason="the media-timeline path needs OpenTimelineIO (KMI §4 adopts it)",
)

CORE = Path(__file__).resolve().parents[2] / "core"
FIXTURE = CORE / "fixtures" / "timeline.otio.json"


@pytest.fixture(scope="module")
def timeline_json() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def clips(document: str) -> list[dict[str, Any]]:
    """Every clip in an OTIO document, flattened to what KMI §4.1 fixes: name, the
    track kind it sits on, and its in/out as RationalTime value+rate pairs."""
    timeline = json.loads(document)
    out: list[dict[str, Any]] = []
    for track in timeline["tracks"]["children"]:
        for child in track["children"]:
            if not child["OTIO_SCHEMA"].startswith("Clip."):
                continue
            source_range = child["source_range"]
            out.append(
                {
                    "name": child["name"],
                    "kind": track["kind"],
                    "start": (
                        source_range["start_time"]["value"],
                        source_range["start_time"]["rate"],
                    ),
                    "duration": (
                        source_range["duration"]["value"],
                        source_range["duration"]["rate"],
                    ),
                }
            )
    return out


def test_the_path_runs_opentimelineio_itself() -> None:
    """The dependency is explicit and live: the facade reports OTIO's own version and the
    adapters this interpreter has, rather than a list agora maintains."""
    assert translation_py.otio_version() == otio.__version__
    available = translation_py.otio_adapters()
    assert available == sorted(available)
    assert "otio_json" in available
    # The gate venv installs the CMX3600 and FCP plugin distributions (test.sh); a caller
    # who did not gets a clear error naming what is reachable, asserted below.
    assert "cmx_3600" in available


def test_canonical_round_trip_is_lossless(timeline_json: str) -> None:
    """OTIO JSON in, translated through the engine, and back out — clips, tracks and
    timing preserved exactly, and the whole document equivalent by OTIO's own reckoning."""
    canonical = translation_py.timeline_to_adapter(timeline_json, "otio_json")
    back = translation_py.timeline_from_adapter(canonical, "otio_json")

    assert clips(back) == clips(timeline_json)
    tracks = [(t["name"], t["kind"]) for t in json.loads(back)["tracks"]["children"]]
    assert tracks == [("V1", "Video"), ("A1", "Audio"), ("A2", "Audio")]

    # Structural equality of the full document, OTIO's own equivalence included — nothing
    # OTIO put in the fixture was dropped on the way through.
    assert json.loads(back) == json.loads(timeline_json)
    assert otio.adapters.read_from_string(back, "otio_json").is_equivalent_to(
        otio.adapters.read_from_string(timeline_json, "otio_json")
    )


def test_cmx3600_interchange_is_otios_adapter_and_round_trips(timeline_json: str) -> None:
    """canonical → CMX3600 → canonical, with OTIO's ``cmx_3600`` adapter doing both legs.

    CMX3600 is a single-video-track format, so the edit handed to it is the video track —
    the timeline's shape is not something the engine may quietly change to fit a format.
    """
    video_only = json.loads(timeline_json)
    video_only["tracks"]["children"] = video_only["tracks"]["children"][:1]
    video_only_json = json.dumps(video_only)

    edl = translation_py.timeline_to_adapter(video_only_json, "cmx_3600")
    # Written by OTIO's adapter, not by us: an EDL event table with OTIO's own comments.
    assert "TITLE: recap-trailer" in edl
    assert "* FROM CLIP NAME:  renaud-approach" in edl

    back = translation_py.timeline_from_adapter(edl, "cmx_3600")
    assert clips(back) == clips(video_only_json)
    assert json.loads(back)["tracks"]["children"][0]["kind"] == "Video"

    # The format's own edge, stated rather than papered over (§4.3): an EDL addresses
    # media by path, so koine's asset id does not survive the trip inside the document —
    # which is exactly why a media map must travel with adapter output.
    reference = json.loads(back)["tracks"]["children"][0]["children"][0]
    reference = reference["media_references"][reference["active_media_reference_key"]]
    assert "koine" not in reference.get("metadata", {})
    assert reference["target_url"] == "file:///conform/renaud-approach.mov"


def test_fcp_interchange_round_trips_through_otios_adapter(timeline_json: str) -> None:
    """The same, through the FCP7 ``xmeml`` adapter — the second §4.3 row, and evidence
    the path is OTIO's adapter *set*, not one format special-cased."""
    pytest.importorskip("otio_fcp_adapter", reason="FCP adapter plugin not installed")
    video_only = json.loads(timeline_json)
    video_only["tracks"]["children"] = video_only["tracks"]["children"][:1]
    video_only_json = json.dumps(video_only)

    xmeml = translation_py.timeline_to_adapter(video_only_json, "fcp_xml")
    assert xmeml.lstrip().startswith("<?xml")
    back = translation_py.timeline_from_adapter(xmeml, "fcp_xml")
    assert clips(back) == clips(video_only_json)


def test_non_canonical_input_is_refused_before_otio_sees_it(timeline_json: str) -> None:
    """The engine checks KMI §4.1/§4.4 on the way past. A legacy JSON-EDL document is not
    a canonical timeline, and the refusal says what replaced the field."""
    legacy = {
        "OTIO_SCHEMA": "Timeline.1",
        "fps": 23.976,
        "tracks": {"OTIO_SCHEMA": "Stack.1", "children": []},
    }
    with pytest.raises(ValueError, match="application/vnd.koine.edl\\+json"):
        translation_py.timeline_to_adapter(json.dumps(legacy), "otio_json")


def test_unknown_adapter_names_what_is_reachable(timeline_json: str) -> None:
    """Adapter availability is OTIO's business — the NLE adapters are separate plugin
    distributions — so an unknown name reports the live list instead of a plugin
    traceback."""
    with pytest.raises(ValueError, match="unknown OTIO adapter"):
        translation_py.timeline_to_adapter(timeline_json, "premiere_xml")
