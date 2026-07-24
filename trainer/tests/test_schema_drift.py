"""The vendored koine schemas are pinned byte-for-byte to the koine sibling checkout.

The trainer ships a copy of ``finetune-job.schema.json`` (+ the two schemas it refs) so a
deployed service validates jobs without a ``../koine`` beside it (ADR-0001). That copy is a
snapshot, and a snapshot drifts: this test byte-compares each vendored file against koine's
canonical ``schemas/`` — the same discipline the TS side keeps for the koine registry fixture
(``schemas/src/koine-fixture-drift.test.ts``). A ``koine:*`` bump that advanced the schema is
red here until the copy is refreshed (recopy from koine, never hand-edit).

koine is a sibling of the agora working tree (``../koine``); resolved against both this tree's
own root and — for a git worktree, whose ``../koine`` does not exist — the primary working tree
via git's common dir. An absent koine skips (a standalone agora checkout), never silently
passes as green.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agora_trainer.schemas import SCHEMA_FILES

VENDORED_DIR = Path(__file__).resolve().parents[1] / "src" / "agora_trainer" / "schemas"


def _koine_schemas_dir() -> Path | None:
    repo_root = Path(__file__).resolve().parents[2]
    roots = [repo_root]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if common:
            roots.append(Path(common).parent)  # the primary working tree's root
    except (OSError, subprocess.CalledProcessError):
        pass  # git unavailable — the relative candidate is all we can try
    for root in roots:
        candidate = root.parent / "koine" / "schemas"
        if (candidate / "finetune-job.schema.json").exists():
            return candidate
    return None


KOINE_DIR = _koine_schemas_dir()


@pytest.mark.skipif(
    KOINE_DIR is None,
    reason="standalone checkout: the koine sibling (../koine/schemas) is absent",
)
@pytest.mark.parametrize("name", SCHEMA_FILES)
def test_vendored_schema_is_byte_identical_to_koine(name: str) -> None:
    assert KOINE_DIR is not None  # narrowed for the type checker; skipif guards the None case
    vendored = (VENDORED_DIR / name).read_bytes()
    canonical = (KOINE_DIR / name).read_bytes()
    assert vendored == canonical, (
        f"{name} has drifted from koine; refresh it (do not hand-edit):\n"
        f"  cp {KOINE_DIR / name} {VENDORED_DIR / name}"
    )
