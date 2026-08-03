"""The byte-for-byte corpus is a capture of THIS router, and this keeps it one.

``provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json`` is the contract
of record for the supersession gate (ADR-0004): ``apr_conformance_SUITE`` replays it against
the Erlang router and demands identical bytes. But that suite only runs where Erlang does,
and ``make check-router-erl`` *skips* on a host without rebar3 — so on most machines nothing
was checking the other half of the equality, that the corpus still matches what the Python
router answers. A stale corpus is worse than an absent one: it would hold the canonical
router to a surface no code produces any more.

This is the same shape of pin as ``test_conformance_fixture.py`` (which pins the console's
captured session), one consumer over, and it is what lets US-3 (agora:10) say the corpus is
**live** rather than frozen — see ``docs/router-hand-built-behaviours.md``.

The capture runs in a subprocess because ``capture_python_surface.py`` clears ``os.environ``
wholesale — that is deliberate there (the record must be a function of the file, not of the
capturing host) and it would wreck the rest of this test session in-process. The comparison
is on the exact bytes, since that is what the corpus is for.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_DIR = REPO_ROOT / "provider-router-erl" / "test" / "apr_conformance_SUITE_data"
CAPTURE = CORPUS_DIR / "capture_python_surface.py"
CORPUS = CORPUS_DIR / "python-surface.json"

REGENERATE = (
    "uv --project provider-router run python "
    "provider-router-erl/test/apr_conformance_SUITE_data/capture_python_surface.py "
    "> provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json"
)


class TestTheConformanceCorpus:
    @pytest.mark.skipif(
        not (CAPTURE.exists() and CORPUS.exists()),
        reason=f"standalone checkout: {CORPUS} (the Erlang suite's corpus) is absent",
    )
    def test_the_captured_surface_is_still_what_this_router_answers(self) -> None:
        captured = subprocess.run(
            [sys.executable, str(CAPTURE)],
            capture_output=True,
            check=True,
            cwd=REPO_ROOT,
        )
        assert captured.stdout.decode("utf-8") == CORPUS.read_text(encoding="utf-8"), (
            f"{CORPUS} no longer matches this router's surface.\n"
            "It is the corpus apr_conformance_SUITE holds the canonical Erlang router to, so a\n"
            "difference is either an intended contract change (regenerate, and change the\n"
            "Erlang router to match) or an accidental one (revert it). Regenerate from the\n"
            f"repo root with:\n  {REGENERATE}"
        )
