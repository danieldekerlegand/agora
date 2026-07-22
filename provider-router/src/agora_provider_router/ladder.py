"""The sacred ladder — per-modality tier ordering, ported from Analyzer.

Reference: ``~/Development/analyzer/src/filmstudio/core/ladders.py``. Two things carry over
verbatim in spirit:

* The order is **configuration, not hardcode**: ``AGORA_<MODALITY>_LADDER`` names a
  comma-separated tier order and ``AGORA_PREFER_LOCAL=1`` fronts the zero-spend tiers.
* The **placeholder is not a ladder token**. It is the unconditional terminal tier every
  modality ends on, so a configured ladder can narrow *which* backends are tried but can
  never break the always-completes contract (:mod:`agora_provider_router.router`).

What changed in the port: Analyzer's tokens were provider names (``veo``, ``runway``, …)
because its ladder lived inside each media skill. Here the router *is* the ladder, so the
tokens are the four tiers ADR-0001 names — ``paid`` → ``mlx`` → ``local`` → placeholder —
and the per-modality vendor preference moves into :data:`PAID_PROVIDERS`.

Pure stdlib; :func:`resolve_all` never raises, so ``/doctor`` always answers.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: The modalities the router ladders. ``speech`` is Analyzer's ``tts`` modality, renamed to
#: match the mlx-serve endpoint vocabulary it shares with ``image``/``music``/``video``.
MODALITIES: tuple[str, ...] = ("text", "image", "speech", "music", "video")

#: Configurable tier tokens, cheapest-last. ``placeholder`` is deliberately absent — see
#: the module docstring.
TIERS: tuple[str, ...] = ("paid", "mlx", "local")

#: The terminal tier. Always appended, never configurable away.
PLACEHOLDER = "placeholder"

#: The zero-spend tiers ``AGORA_PREFER_LOCAL`` moves to the front, in lead order.
LOCAL_TIERS: tuple[str, ...] = ("mlx", "local")

PREFER_LOCAL_ENV = "AGORA_PREFER_LOCAL"

#: modality → default tier order. Cloud-first, matching Analyzer's shipped defaults.
DEFAULT_LADDERS: dict[str, tuple[str, ...]] = dict.fromkeys(MODALITIES, TIERS)

#: modality → the env var naming its ladder override.
LADDER_ENV: dict[str, str] = {m: f"AGORA_{m.upper()}_LADDER" for m in MODALITIES}


def ladder_env_var(modality: str) -> str:
    return LADDER_ENV[modality]


def default_ladder(modality: str) -> tuple[str, ...]:
    return DEFAULT_LADDERS[modality]


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def resolve_ladder(modality: str, env: Mapping[str, str]) -> tuple[str, ...]:
    """The configured tier order for ``modality``, WITHOUT the terminal placeholder.

    Raises ``ValueError`` on an unknown modality or an unknown tier token — the message
    names the offending variable and lists the valid tokens. Duplicates keep their first
    position; ``AGORA_PREFER_LOCAL`` fronting applies on top of either order.
    """
    if modality not in DEFAULT_LADDERS:
        raise ValueError(
            f"unknown ladder modality {modality!r} "
            f"(expected one of {', '.join(sorted(DEFAULT_LADDERS))})"
        )
    default = DEFAULT_LADDERS[modality]
    var = LADDER_ENV[modality]
    raw = str(env.get(var) or "").strip()
    tiers: list[str] = []
    for token in raw.split(","):
        name = token.strip().lower()
        if not name:
            continue
        if name == PLACEHOLDER:
            # Not a rejection: the placeholder is always the last tier anyway, so naming
            # it is redundant rather than wrong. Dropping it keeps the token list honest.
            continue
        if name not in default:
            raise ValueError(
                f"{var}: unknown {modality} tier {name!r} — valid tiers: {', '.join(default)}"
            )
        if name not in tiers:
            tiers.append(name)
    if not tiers:
        tiers = list(default)
    if _truthy(env.get(PREFER_LOCAL_ENV)):
        local = [t for t in LOCAL_TIERS if t in tiers]
        tiers = local + [t for t in tiers if t not in local]
    return tuple(tiers)


def safe_resolve(modality: str, env: Mapping[str, str]) -> tuple[tuple[str, ...], str | None]:
    """``(tiers, error)`` — never raises for a known modality.

    A bad ladder variable degrades to the default order (``AGORA_PREFER_LOCAL`` still
    honoured) and returns the rejection string, so the caller can warn loudly. A bad env
    var must never abort a run.
    """
    try:
        return resolve_ladder(modality, env), None
    except ValueError as exc:
        clean = {PREFER_LOCAL_ENV: str(env.get(PREFER_LOCAL_ENV) or "")}
        return resolve_ladder(modality, clean), str(exc)


def resolve_all(env: Mapping[str, str]) -> dict[str, dict[str, Any]]:
    """Every modality's configured ladder for the doctor report. Never raises."""
    report: dict[str, dict[str, Any]] = {}
    for modality, var in LADDER_ENV.items():
        tiers, error = safe_resolve(modality, env)
        entry: dict[str, Any] = {
            "ladder": [*tiers, PLACEHOLDER],
            "source": "env" if str(env.get(var) or "").strip() and error is None else "default",
            "prefer_local": _truthy(env.get(PREFER_LOCAL_ENV)),
        }
        if error:
            entry["error"] = error
        report[modality] = entry
    return report
