"""Finetune-job admission validation (KFT §3, FT-F).

Two gates run at admission, before any compute is committed:

1. **Schema** — the payload is validated against the vendored ``finetune-job.schema.json``
   (KFT §3, draft-2020-12). This is the machine-readable twin of the job manifest; a payload
   that violates it (missing ``base_model``, an unknown ``modality`` token, an inline dataset)
   is rejected here.
2. **Semantics** — ``modality`` and ``method`` are *not* independent (KFT §3.1): an
   incompatible combination (e.g. ``dpo`` on ``text-to-image``) is a valid-shaped payload the
   provider still MUST reject (FT-F). :mod:`agora_trainer.modality` is the source of truth for
   which methods this general provider serves per modality.

Both produce a structured :class:`Report`. The egress gate (§4.2) and the spend ceiling (§7)
are *also* admission gates but need resolved data cardinality / a grant, so they live in US-3;
this module is the shape/compatibility gate that runs first.

**Exit-code semantics** (matching agora's validators): ``0`` valid, ``1`` invalid (schema or
semantic), ``2`` usage (the job could not be read at all — absent file, unparseable JSON, not
an object). The CLI (:func:`main`) and the HTTP surface (:mod:`agora_trainer.app`) both map to
these three outcomes so a caller gets the same verdict over either transport.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from enum import IntEnum
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .modality import BY_NAME, supports
from .schemas import load_registry, load_schema


class Status(IntEnum):
    """The verdict of admission — its value is the process exit code the CLI returns."""

    OK = 0
    INVALID = 1
    USAGE = 2


@dataclass(frozen=True)
class Problem:
    """One reason a job was rejected — a stable ``code``, where it is, and what is wrong."""

    code: str
    path: str
    message: str

    def describe(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


@dataclass(frozen=True)
class Report:
    """The structured admission verdict for one job (KFT §3.1, FT-F)."""

    status: Status
    problems: tuple[Problem, ...] = field(default_factory=tuple)

    @property
    def ok(self) -> bool:
        return self.status is Status.OK

    def describe(self) -> dict[str, Any]:
        """The wire form — what both the CLI (as JSON) and HTTP (as the body) return."""
        return {
            "ok": self.ok,
            "status": self.status.name.lower(),
            "exit_code": int(self.status),
            "problems": [p.describe() for p in self.problems],
        }


@dataclass(frozen=True)
class Loaded:
    """A job read from a source: either the parsed payload or a USAGE-level read failure."""

    payload: dict[str, Any] | None
    report: Report | None


def _pointer(path: Any) -> str:
    """A JSON-pointer-ish path (``/dataset/knowledge/0``) from a jsonschema error path."""
    parts = [str(part) for part in path]
    return "/" + "/".join(parts) if parts else "/"


def _schema_problems(payload: dict[str, Any]) -> list[Problem]:
    """Every draft-2020-12 violation of ``finetune-job.schema.json``, in document order."""
    registry = load_registry()
    schema = load_schema("finetune-job.schema.json")
    validator = Draft202012Validator(schema, registry=registry)
    problems: list[Problem] = []
    for error in sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path)):
        problems.append(
            Problem(code="schema", path=_pointer(error.absolute_path), message=error.message)
        )
    return problems


def _compatibility_problems(payload: dict[str, Any]) -> list[Problem]:
    """The KFT §3.1 modality × method gate (FT-F) — run only once both tokens are present.

    The schema already rejects an unknown ``modality`` / ``method`` token; this catches the
    *combination* the schema cannot express: a token pair that is individually valid but that
    this general provider does not serve together.
    """
    modality = payload.get("modality")
    method = payload.get("method")
    if not isinstance(modality, str) or not isinstance(method, str):
        return []  # a missing/mistyped token is the schema gate's problem to report.
    if modality not in BY_NAME:
        return []  # an unknown modality is likewise the schema gate's to report.
    if supports(modality, method):
        return []
    served = ", ".join(BY_NAME[modality].methods)
    return [
        Problem(
            code="modality-method",
            path="/method",
            message=(
                f"method {method!r} is not compatible with modality {modality!r} "
                f"(KFT §3.1, FT-F); this provider serves: {served}"
            ),
        )
    ]


def validate_job(payload: Any) -> Report:
    """Admit ``payload`` — schema (KFT §3) then modality × method (§3.1, FT-F).

    Never raises: a malformed payload becomes problems, not an exception. A non-object payload
    is a USAGE error (it is not a job at all); anything else is OK or INVALID.
    """
    if not isinstance(payload, dict):
        return Report(
            status=Status.USAGE,
            problems=(
                Problem(
                    code="not-an-object",
                    path="/",
                    message=f"a finetune job must be a JSON object, got {type(payload).__name__}",
                ),
            ),
        )
    problems = [*_schema_problems(payload), *_compatibility_problems(payload)]
    status = Status.INVALID if problems else Status.OK
    return Report(status=status, problems=tuple(problems))


def load_job(source: Path) -> Loaded:
    """Read + parse a job file; a read/parse failure is a USAGE-level :class:`Report`."""
    try:
        raw = source.read_text(encoding="utf-8")
    except OSError as exc:
        return Loaded(None, _usage(f"cannot read {source}: {exc.strerror or exc}"))
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return Loaded(None, _usage(f"{source} is not valid JSON: {exc}"))
    return Loaded(payload, None)


def _usage(message: str) -> Report:
    return Report(status=Status.USAGE, problems=(Problem("usage", "/", message),))


def main(argv: list[str] | None = None) -> int:
    """CLI: ``agora-trainer-validate <job.json>`` — 0 valid / 1 invalid / 2 usage.

    Prints the :class:`Report` as JSON to stdout so a caller can machine-read the verdict, and
    returns the exit code so a shell can branch on it.
    """
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        report = _usage("usage: agora-trainer-validate <finetune-job.json>")
        print(json.dumps(report.describe(), indent=2))
        return int(report.status)
    loaded = load_job(Path(args[0]))
    report = loaded.report if loaded.report is not None else validate_job(loaded.payload)
    print(json.dumps(report.describe(), indent=2))
    return int(report.status)


if __name__ == "__main__":
    raise SystemExit(main())
