"""The trainer's HTTP surface — liveness, the A2A agent card, and the KCB manifest.

Deliberately small in US-1: the trainer *publishes itself* so the registry can crawl it and
peers can discover it, but the `finetune` invoke / subscribe task surface (job admission,
telemetry) lands in US-2 / US-6. Every route here corresponds to an endpoint the manifest
advertises, and no manifest endpoint is unserved (ADR-0001 decision 3).

The config is built once from the process environment and cached; tests build their own
:class:`TrainerConfig` and override :func:`get_config`, so no test mutates global state.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import KCB_VERSION, KFT_VERSION, __version__
from .config import TrainerConfig
from .engine import UnsupportedJob
from .grant import Grant
from .manifest import AGENT_CARD_PATH, MANIFEST_PATH, agent_card, capability_manifest
from .runner import RunRejected, run
from .validate import Problem, Report, Status

app = FastAPI(title="agora trainer", version=__version__)

#: The §6 telemetry stream's content type — newline-delimited JSON, one event per line.
TELEMETRY_MEDIA_TYPE = "application/x-ndjson"

#: The header carrying the `invoke:finetune` grant's gpu-seconds ceiling (KFT §7). Absent → an
#: ungated grant (signing the token is the caller's governance, US-6); a value gates spend.
BUDGET_HEADER = "X-Agora-Budget-Units"

#: The admission verdict → HTTP status, the transport twin of the CLI exit codes
#: (0 ok / 1 invalid / 2 usage): a valid job streams (200), a schema/semantic failure is
#: unprocessable (422), and an unreadable request is a client usage error (400).
_HTTP_STATUS: dict[Status, int] = {
    Status.OK: 200,
    Status.INVALID: 422,
    Status.USAGE: 400,
}


@lru_cache(maxsize=1)
def get_config() -> TrainerConfig:
    """The process-wide config. Cached: it is an environment snapshot."""
    return TrainerConfig.from_env()


ConfigDep = Annotated[TrainerConfig, Depends(get_config)]


@app.get("/health")
def health(config: ConfigDep) -> dict[str, str]:
    """Liveness + identity. Holds no secrets to leak."""
    return {
        "status": "ok",
        "identity": config.identity,
        "version": __version__,
        "kcb_version": KCB_VERSION,
        "kft_version": KFT_VERSION,
    }


@app.get(AGENT_CARD_PATH)
def a2a_agent_card(config: ConfigDep) -> dict[str, Any]:
    """The A2A agent card — the dialable address, pointing at the KCB manifest (KCB §3)."""
    return agent_card(config)


@app.get(MANIFEST_PATH)
def kcb_manifest(config: ConfigDep) -> dict[str, Any]:
    """The trainer's KCB capability manifest (KCB §2, KFT §2) — what the registry indexes."""
    return capability_manifest(config)


@app.post("/invoke")
async def invoke(request: Request) -> Response:
    """`invoke` the `finetune` capability (KCB §4) — admit the job, then stream §6 telemetry.

    Admission (KFT §3/§4.2/§7) runs first, over the full gate: an unreadable body is a usage
    error (400), and any admission failure — a schema/semantic reject (FT-F), an egress-gate or
    placement reject (§4.2/FT-J), or an over-ceiling spend reject (FT-E) — is unprocessable (422)
    with the structured report as the body, the HTTP twin of the validator's exit codes. The §7
    grant ceiling rides the ``X-Agora-Budget-Units`` header. A valid job is run and its
    training-telemetry stream (§6) is returned as newline-delimited JSON: one event per step in
    monotonic order, then the terminal event carrying the finetuned-model id + weight asset ids.
    A modality that is compatible but has no wired engine yet (US-4) is a distinct 501.
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _reject(_usage_report("request body is not valid JSON"))
    try:
        events = run(payload, grant=_grant_from(request))
    except RunRejected as exc:
        return _reject(exc.report)
    except UnsupportedJob as exc:
        return JSONResponse(
            status_code=501,
            content={
                "ok": False,
                "status": "unsupported",
                "problems": [
                    Problem("no-engine", "/modality", str(exc)).describe(),
                ],
            },
        )

    def _ndjson() -> Iterator[bytes]:
        for event in events:
            yield (json.dumps(event.describe()) + "\n").encode("utf-8")

    return StreamingResponse(
        _ndjson(),
        media_type=TELEMETRY_MEDIA_TYPE,
        headers={"X-Agora-Job": str(payload["job"])},
    )


def _grant_from(request: Request) -> Grant:
    """Build the §7 grant from the ``X-Agora-Budget-Units`` header — absent/unparseable → ungated.

    A real grant is a signed ``invoke:finetune`` token (KCB §5, US-6); until that lands the header
    carries just its load-bearing field, the ``budget_units`` ceiling.
    """
    raw = request.headers.get(BUDGET_HEADER)
    if raw is None:
        return Grant()
    try:
        return Grant(budget_units=float(raw))
    except ValueError:
        return Grant()


def _reject(report: Report) -> JSONResponse:
    """Render an admission rejection at the mapped HTTP status (KFT §3.1)."""
    return JSONResponse(status_code=_HTTP_STATUS[report.status], content=report.describe())


def _usage_report(message: str) -> Report:
    return Report(status=Status.USAGE, problems=(Problem("usage", "/", message),))
