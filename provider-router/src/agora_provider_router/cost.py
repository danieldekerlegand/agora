"""Cost estimation and the spend ceiling — the router's half of KCB's ``budget_units``.

KCB grants are "per-capability, per-world, and carry a spend ceiling (``budget_units``)"
(``koine/specs/capability-bus.md`` §5), and path search "prefers zero-cost routes and
surfaces the projected cost before an invoke" (§3). This module is what makes that concrete
for the ladder: it prices a request **before** dispatch so the router can refuse a rung that
would exceed the caller's ceiling, and prices it again **after** so the response reports what
was actually spent.

Everything here is **pure** in the value sense — no network, no clock, no process env. The
default rates ship as data (``prices.toml`` beside this module, loaded once at import), and
are overridable two ways from the ``AGORA_*`` mapping the config already keeps
(:mod:`agora_provider_router.config`): a deployer can replace or extend the *whole* sheet by
pointing ``AGORA_PRICE_TABLE`` at their own TOML/JSON file, or nudge a single rate with a
per-``(modality, provider)`` ``AGORA_PRICE_<MODALITY>_<PROVIDER>`` var. The per-rate override
wins over both the replacement file and the shipped defaults.

A fifth source sits between them, off unless a deployer switches it on: LiteLLM's
maintained per-model price map (:mod:`agora_provider_router.litellm_prices`,
``AGORA_PRICE_LITELLM=1``). It only ever *fills in* rates — under both deployer-set layers,
over the shipped per-provider estimate, and silent about any model it does not price. See
that module for the full precedence and for why a source may not name its own denomination.

The unit
--------
Costs are denominated in KCB **budget units**, not currency: a grant's ceiling travels
between projects that do not share a billing account, so the bus needs one comparable
scalar. The table is anchored at **1 unit = US$0.00001** (:data:`BUDGET_UNITS_PER_USD`, so
$0.05/second of video = 5000 units/second), which keeps whole numbers for media and sub-unit
rates for tokens. That anchor is restated at the top of ``prices.toml`` so the shipped
numbers stay self-explaining, and it is applied *here* to anything a currency-denominated
source hands over: the denomination is the cost model's, never a source's.

**All rates are conservative estimates, not quotes.** Provider pricing changes constantly;
every :class:`Cost` carries the inputs it was computed from (``quantity`` × ``rate``) so a
caller can check the arithmetic rather than trust the total. Override any single rate with
``AGORA_PRICE_<MODALITY>_<PROVIDER>`` (e.g. ``AGORA_PRICE_VIDEO_RUNWAY=4000``); the
provider part uppercases with non-alphanumerics replaced by ``_``.

The two safety rules
--------------------
* **An unpriceable rung never passes a ceiling.** A provider with no published rate prices
  as ``unpriced``, and :func:`within` refuses it whenever a ceiling is set — "we don't know"
  must not read as "free", or an unknown vendor becomes the cheapest route in the ladder.
* **A ceiling only ever fails safe.** A negative ceiling clamps to zero rather than being
  ignored, and an unparseable one is an error (:func:`parse_ceiling`) rather than a silent
  absence — treating a malformed ceiling as "no ceiling" would authorise unlimited spend on
  a typo.
"""

from __future__ import annotations

import json
import math
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

from . import litellm_prices
from .backends import LOCAL_PROVIDER, MLX_PROVIDER
from .ladder import PLACEHOLDER

#: Prefix of a per-``(modality, provider)`` rate override, read from the ``AGORA_*`` env.
PRICE_ENV_PREFIX = "AGORA_PRICE_"

#: Env var pointing at a replacement price sheet (TOML or JSON) that supplants/extends the
#: shipped :data:`RATES`. Read from the ``AGORA_*`` mapping, not the process env.
PRICE_TABLE_ENV = "AGORA_PRICE_TABLE"

#: The shipped default price sheet, packaged beside this module.
PRICE_SHEET_FILE = "prices.toml"

#: The KCB budget-unit anchor: 1 unit = US$0.00001, so a US dollar is this many units. The
#: only place a currency becomes a denomination — a rate source speaks its vendor's currency
#: and the conversion happens here, because a ceiling that travels between projects with no
#: shared billing account cannot be denominated in one of their currencies.
BUDGET_UNITS_PER_USD = 100_000.0

#: The request-body key and header carrying a per-request spend ceiling (KCB §5).
BUDGET_KEY = "budget_units"
BUDGET_HEADER = "X-Agora-Budget-Units"


def _parse_price_sheet(
    text: str, *, is_json: bool
) -> tuple[dict[str, str], dict[str, dict[str, float]]]:
    """``(unit_of, rates)`` parsed from a TOML or JSON price sheet.

    A sheet is ``{"unit_of": {modality: unit}, "rates": {modality: {provider: rate}}}``. Both
    sections are optional so a replacement file may carry only the rates it wants to change.
    """
    data = json.loads(text) if is_json else tomllib.loads(text)
    unit_of = {str(k): str(v) for k, v in dict(data.get("unit_of", {})).items()}
    rates: dict[str, dict[str, float]] = {
        str(modality): {str(provider): float(rate) for provider, rate in dict(providers).items()}
        for modality, providers in dict(data.get("rates", {})).items()
    }
    return unit_of, rates


@cache
def _load_price_sheet(path: str) -> tuple[dict[str, str], dict[str, dict[str, float]]]:
    """Parse the price sheet at ``path``, cached by path so a lookup does not re-read it."""
    p = Path(path)
    return _parse_price_sheet(p.read_text(encoding="utf-8"), is_json=p.suffix.lower() == ".json")


def _load_shipped_sheet() -> tuple[dict[str, str], dict[str, dict[str, float]]]:
    """The default sheet packaged as :data:`PRICE_SHEET_FILE` beside this module."""
    text = resources.files(__package__).joinpath(PRICE_SHEET_FILE).read_text(encoding="utf-8")
    return _parse_price_sheet(text, is_json=False)


_UNIT_OF, _RATES = _load_shipped_sheet()

#: What one unit of ``quantity`` is, per modality — the thing a rate is charged against.
#: Loaded from the shipped :data:`PRICE_SHEET_FILE` at import.
UNIT_OF: dict[str, str] = _UNIT_OF

#: modality → provider → budget units per :data:`UNIT_OF` unit. Conservative ESTIMATES
#: (output-side rates where a vendor bills input and output differently). Loaded from the
#: shipped :data:`PRICE_SHEET_FILE` at import; a deployer replaces/extends it wholesale via
#: :data:`PRICE_TABLE_ENV`, or one rate at a time via :func:`price_env_var`.
RATES: dict[str, dict[str, float]] = _RATES

#: Providers that genuinely cost nothing — priced ``0.0`` and NOT flagged unpriced. These
#: are the zero-spend tiers the always-completes invariant rests on: self-hosted compute and
#: the offline placeholder. A user who wants to price their own electricity can still set an
#: ``AGORA_PRICE_*`` override, which wins over this set.
FREE_PROVIDERS: frozenset[str] = frozenset({MLX_PROVIDER, LOCAL_PROVIDER, PLACEHOLDER})

#: Characters per token when sizing a prompt. Deliberately low (real English is ~4) so the
#: projection over-counts rather than under-counts against a ceiling.
CHARS_PER_TOKEN = 3.5

#: Sizes assumed when the request does not state one. Each errs high, for the same reason.
DEFAULT_COMPLETION_TOKENS = 1024.0
DEFAULT_SPEECH_CHARS = 200.0
DEFAULT_VIDEO_SECONDS = 5.0


@dataclass(frozen=True)
class Cost:
    """A priced request: the total, and the arithmetic that produced it.

    ``estimate`` is ``True`` when ``quantity`` was projected from the request and ``False``
    when it was read back off the provider's own response (``usage.total_tokens``, the
    returned ``data`` items) — so a caller can tell a settled cost from a guessed one.
    """

    units: float
    unit: str
    quantity: float
    rate: float
    unpriced: bool = False
    estimate: bool = True

    def describe(self) -> dict[str, object]:
        return {
            "units": self.units,
            "unit": self.unit,
            "quantity": self.quantity,
            "rate": self.rate,
            "unpriced": self.unpriced,
            "estimate": self.estimate,
        }


def price_env_var(modality: str, provider: str) -> str:
    """``("video", "runway")`` → ``AGORA_PRICE_VIDEO_RUNWAY``."""
    safe = "".join(c if c.isalnum() else "_" for c in provider).upper()
    return f"{PRICE_ENV_PREFIX}{modality.upper()}_{safe}"


def rate_for(
    modality: str,
    provider: str,
    env: Mapping[str, str] | None = None,
    *,
    model: str | None = None,
) -> tuple[float, bool]:
    """``(rate, unpriced)`` in budget units per :data:`UNIT_OF` unit.

    Four layers, most specific first: the per-``(modality, provider)`` env override, the
    zero-spend tiers held in :data:`FREE_PROVIDERS`, a deployer's replacement sheet
    (:data:`PRICE_TABLE_ENV`), the optional per-``model`` LiteLLM price map
    (:mod:`agora_provider_router.litellm_prices`), and last the shipped :data:`RATES`. A
    provider none of them prices is ``0.0`` **flagged unpriced** — see the module docstring
    for why that flag matters. A malformed override is ignored so the layer under it stands.

    ``model`` is optional because most callers price a *provider*: the rung's cost does not
    depend on it under any of the hand-set layers, and passing it only opens the sourced one.
    """
    env = env or {}
    raw = env.get(price_env_var(modality, provider))
    if raw and raw.strip():
        try:
            override = float(raw)
        except ValueError:
            override = -1.0
        if override >= 0 and math.isfinite(override):
            return override, False
    if provider in FREE_PROVIDERS:
        return 0.0, False
    replacement = _replacement_rates(modality, env)
    if provider in replacement:
        return replacement[provider], False
    usd = litellm_prices.usd_rate_for(modality, provider, model, env)
    if usd is not None:
        return round(usd * BUDGET_UNITS_PER_USD, 9), False
    shipped = RATES.get(modality, {})
    if provider in shipped:
        return shipped[provider], False
    return 0.0, True


def _replacement_rates(modality: str, env: Mapping[str, str]) -> dict[str, float]:
    """The rates a deployer's replacement sheet (:data:`PRICE_TABLE_ENV`) sets for ``modality``.

    Empty when no sheet is configured — and empty when the configured one cannot be read, so
    a typo'd path falls through to the layers under it rather than un-pricing a rung: an
    unreadable file must never make a paid rung read as affordable, nor as free.
    """
    path = env.get(PRICE_TABLE_ENV)
    if not (path and path.strip()):
        return {}
    try:
        _, replacement = _load_price_sheet(path.strip())
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        return {}
    return replacement.get(modality, {})


def measure(modality: str, payload: Mapping[str, Any]) -> float:
    """How many :data:`UNIT_OF` units ``payload`` asks for. Never raises."""
    if modality == "text":
        completion = payload.get("max_completion_tokens", payload.get("max_tokens"))
        tokens = _non_negative(completion, DEFAULT_COMPLETION_TOKENS)
        return round(_prompt_chars(payload) / CHARS_PER_TOKEN + tokens, 6)
    if modality == "speech":
        for key in ("input", "text"):
            value = payload.get(key)
            if isinstance(value, str):
                return float(len(value))
        return DEFAULT_SPEECH_CHARS
    count = _non_negative(payload.get("n"), 1.0) or 1.0
    if modality == "video":
        seconds = payload.get("duration", payload.get("seconds"))
        return round(_non_negative(seconds, DEFAULT_VIDEO_SECONDS) * count, 6)
    return count


def project(
    modality: str,
    provider: str,
    payload: Mapping[str, Any],
    env: Mapping[str, str] | None = None,
    *,
    model: str | None = None,
) -> Cost:
    """The cost this request *would* incur on ``provider`` — computed before dispatch."""
    rate, unpriced = rate_for(modality, provider, env, model=model)
    quantity = measure(modality, payload)
    return Cost(
        units=round(rate * quantity, 6),
        unit=UNIT_OF.get(modality, "unit"),
        quantity=quantity,
        rate=rate,
        unpriced=unpriced,
    )


def settle(
    modality: str,
    provider: str,
    payload: Mapping[str, Any],
    response: Mapping[str, Any],
    env: Mapping[str, str] | None = None,
    *,
    model: str | None = None,
) -> Cost:
    """The cost the request *did* incur, read off the response where the provider reports it.

    Falls back to the projection when it does not (``estimate`` stays ``True`` so the
    difference is visible). The placeholder reports a zero-token ``usage`` block, so the
    zero-spend tier settles as a *measured* zero rather than an assumed one.
    """
    rate, unpriced = rate_for(modality, provider, env, model=model)
    reported = _reported_quantity(modality, response)
    quantity = measure(modality, payload) if reported is None else reported
    return Cost(
        units=round(rate * quantity, 6),
        unit=UNIT_OF.get(modality, "unit"),
        quantity=quantity,
        rate=rate,
        unpriced=unpriced,
        estimate=reported is None,
    )


def within(cost: Cost, ceiling: float | None) -> bool:
    """Whether ``cost`` may be spent under ``ceiling``. No ceiling means no constraint."""
    if ceiling is None:
        return True
    if cost.unpriced:
        return False
    return cost.units <= ceiling


def refusal(cost: Cost, ceiling: float, modality: str, provider: str) -> str:
    """Why a rung was skipped — the reason recorded on the attempt, for the caller to read."""
    if cost.unpriced:
        return (
            f"no published {modality} rate for {provider} — cannot prove it fits the "
            f"{ceiling:g}-unit budget ceiling"
        )
    return (
        f"projected {cost.units:g} budget units ({cost.quantity:g} {cost.unit} @ {cost.rate:g}) "
        f"exceeds the {ceiling:g}-unit ceiling"
    )


def take_ceiling(payload: Mapping[str, Any]) -> tuple[dict[str, Any], float | None]:
    """Split ``budget_units`` off the request body.

    Returns a *copy* without the key, so the ceiling — an agora extension, not an OpenAI
    field — is never forwarded to an upstream provider that would reject it.
    """
    body = dict(payload)
    if BUDGET_KEY not in body:
        return body, None
    return body, parse_ceiling(body.pop(BUDGET_KEY))


def parse_ceiling(raw: Any) -> float | None:
    """A ceiling from a request value. ``None`` passes through; junk raises ``ValueError``.

    Negatives clamp to zero (a below-zero budget is a zero budget, not an unlimited one).
    Refusing junk is deliberate: silently dropping an unreadable ceiling would turn a typo
    into unlimited spend authority.
    """
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        raise ValueError(f"{BUDGET_KEY} must be a number of budget units, got {raw!r}")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{BUDGET_KEY} must be a number of budget units, got {raw!r}") from exc
    if not math.isfinite(value):
        raise ValueError(f"{BUDGET_KEY} must be a finite number of budget units, got {raw!r}")
    return max(value, 0.0)


def _prompt_chars(payload: Mapping[str, Any]) -> float:
    """Characters of prompt in a chat- or completion-shaped body."""
    total = 0
    prompt = payload.get("prompt")
    if isinstance(prompt, str):
        total += len(prompt)
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, Mapping):
                total += _content_chars(message.get("content"))
    return float(total)


def _content_chars(content: Any) -> int:
    """A chat message's content length — a string, or the text parts of a multimodal list."""
    if isinstance(content, str):
        return len(content)
    total = 0
    if isinstance(content, list):
        for part in content:
            if isinstance(part, Mapping):
                text = part.get("text")
                if isinstance(text, str):
                    total += len(text)
    return total


def _reported_quantity(modality: str, response: Mapping[str, Any]) -> float | None:
    """The billable quantity the provider itself reported, or ``None`` if it did not."""
    if modality == "text":
        usage = response.get("usage")
        if isinstance(usage, Mapping):
            total = usage.get("total_tokens")
            if isinstance(total, (int, float)) and not isinstance(total, bool):
                return float(total)
        return None
    if modality in ("image", "music"):
        data = response.get("data")
        if isinstance(data, list) and data:
            return float(len(data))
    return None


def _non_negative(value: Any, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number) or number < 0:
        return default
    return number
