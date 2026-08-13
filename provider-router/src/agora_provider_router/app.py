"""The router's HTTP surface — OpenAI-compatible, plus ``/doctor``.

The generation routes are the OpenAI shapes one per modality, each a thin call into
:meth:`~agora_provider_router.router.Router.complete`. They return the upstream response
body verbatim with one addition: an ``agora`` key (mirrored into ``X-Agora-*`` headers)
carrying the resolved tier, provider, model, the rungs that were tried, and the projected
and actual cost. An OpenAI client ignores the extra key; the conformance console (US-AG5)
reads it to show which tier served a request and what it cost, without having to trust a
header surviving CORS.

A request's spend ceiling (KCB §5) rides in the body as ``budget_units`` or in the
``X-Agora-Budget-Units`` header — the header exists because a stock OpenAI SDK will not let
a caller add an unknown body key. The body wins when both are present.

Two more transports carry the KCB §4 ``invoke`` verb: an MCP tool call at
:data:`~agora_provider_router.mcp.MCP_PATH` and an A2A ``message/send`` at
:data:`~agora_provider_router.a2a.A2A_PATH`. Both are JSON-RPC over one POST and both end in
the same :meth:`~agora_provider_router.router.Router.complete` these OpenAI routes call, so
a peer gets the same ladder and the same ceiling whichever way it dials — and it dials *this*
router directly, which is the whole point (ADR-0001 decision 3). Their bodies are read and
their errors are spelled here rather than by the framework: a JSON-RPC caller must get a
JSON-RPC refusal, not a validation shape that belongs to whichever server is hosting.

The router's A2A AgentCard — carrying the KCB capability manifest as its one extension
(capability-bus.md §2/§6) — is served at
:data:`~agora_provider_router.manifest.MANIFEST_PATH` for the registry to crawl or the
router to push (KCB §3). The pre-0.3.0 standalone
:data:`~agora_provider_router.manifest.LEGACY_MANIFEST_PATH` permanently redirects to it.

The router is built once from the process environment and cached. Tests that need a
different configuration build their own :class:`Router` and override the :func:`get_router`
dependency, so no test mutates global state.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from . import KCB_VERSION, ROUTER_IDENTITY, __version__
from . import a2a as a2a_surface
from . import mcp as mcp_surface
from .a2a import A2A_PATH
from .backends import LOCAL_PROVIDER, MLX_PROVIDER, PAID_PROVIDERS, PAID_VENDORS
from .config import RouterConfig
from .cost import BUDGET_HEADER
from .invoke import INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR
from .invoke import error as jsonrpc_error
from .ladder import MODALITIES, resolve_all
from .manifest import LEGACY_MANIFEST_PATH, MANIFEST_PATH, capability_manifest
from .mcp import MCP_PATH
from .router import Router

app = FastAPI(title="agora provider-router", version=__version__)


@lru_cache(maxsize=1)
def get_router() -> Router:
    """The process-wide router. Cached: the configuration is an environment snapshot."""
    return Router(RouterConfig.from_env())


#: The two things every route needs, as annotated types. Annotated rather than a default
#: argument because a call in a default is both a lint error and a shared-mutable trap;
#: ``Depends(get_router)`` by name is also what makes ``dependency_overrides`` work in tests.
RouterDep = Annotated[Router, Depends(get_router)]
Payload = Annotated[dict[str, Any], Body(...)]
#: The header form of the spend ceiling. A non-numeric value is rejected by FastAPI with a
#: 422 rather than being ignored — an unreadable ceiling must never read as "no ceiling".
BudgetHeader = Annotated[float | None, Header(alias=BUDGET_HEADER)]


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness + identity. Never reports secrets or resolved credentials."""
    return {
        "status": "ok",
        "identity": ROUTER_IDENTITY,
        "version": __version__,
        "kcb_version": KCB_VERSION,
    }


@app.get("/doctor")
def doctor(router: RouterDep) -> dict[str, Any]:
    """The resolved ladder per modality, plus how it was configured.

    Diagnostics only — it dials nothing, so it is cheap to poll and honest about
    *configuration* rather than guessing at liveness.
    """
    return {
        "identity": ROUTER_IDENTITY,
        "version": __version__,
        "modalities": router.doctor(),
        "ladders": resolve_all(router.config.env),
        "config": router.config.describe(),
    }


@app.get("/v1/models")
def models(router: RouterDep) -> dict[str, Any]:
    """OpenAI's model list: every model the ladder can currently resolve to."""
    data = [
        {
            "id": backend.model,
            "object": "model",
            "created": 0,
            "owned_by": backend.provider,
            "agora": {"modality": modality, "tier": backend.tier},
        }
        for modality in MODALITIES
        for backend in router.candidates(modality)
    ]
    return {"object": "list", "data": data}


@app.get("/v1/providers")
def providers() -> dict[str, Any]:
    """The vendor vocabulary: what each modality prefers and which wire each speaks.

    A static declaration — no configuration, no secrets. This is what a console renders a
    provider picker from.
    """
    return {
        "modalities": {m: list(PAID_PROVIDERS.get(m, ())) for m in MODALITIES},
        "vendors": [
            {"name": v.name, "wire": v.wire, "base_url": v.base_url}
            for v in sorted(PAID_VENDORS.values(), key=lambda vendor: vendor.name)
        ],
        "keyless": [MLX_PROVIDER, LOCAL_PROVIDER],
    }


@app.get(MANIFEST_PATH)
def agent_card(router: RouterDep) -> dict[str, Any]:
    """The router's A2A AgentCard, carrying the KCB manifest extension (§2/§6).

    What the registry indexes: it reads the ``capabilities.extensions[]`` entry whose ``uri``
    is the KCB manifest extension URI and takes that entry's ``params`` as the manifest.
    """
    return capability_manifest(router)


@app.get(LEGACY_MANIFEST_PATH)
def legacy_kcb_manifest() -> RedirectResponse:
    """Point a pre-0.3.0 crawler at the AgentCard — the manifest folded onto it (§6)."""
    return RedirectResponse(MANIFEST_PATH, status_code=308)


@app.post(MCP_PATH)
async def mcp_endpoint(
    request: Request, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    """One MCP JSON-RPC exchange (KCB §4 ``invoke``, as a tool call)."""
    return await _jsonrpc(mcp_surface.handle, request, router, budget_units)


@app.get(MCP_PATH)
def mcp_stream() -> Response:
    """No server→client stream is offered, which the transport spec spells ``405``."""
    return JSONResponse(
        status_code=405,
        content=jsonrpc_error(
            None, METHOD_NOT_FOUND, f"{MCP_PATH} is a stateless POST surface; it opens no stream"
        ),
    )


@app.post(A2A_PATH)
async def a2a_endpoint(
    request: Request, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    """One A2A JSON-RPC exchange (KCB §4 ``invoke``, as a task)."""
    return await _jsonrpc(a2a_surface.handle, request, router, budget_units)


async def _jsonrpc(
    handler: Callable[[Router, Any, float | None], Awaitable[dict[str, Any] | None]],
    request: Request,
    router: Router,
    budget_units: float | None,
) -> Response:
    """The shape both transports share: parse, hand to the surface, answer.

    A body that is not JSON is a JSON-RPC parse error with the HTTP 400 the transport
    expects — spelled here rather than left to the framework, so a JSON-RPC client is
    refused in the protocol it is speaking. A handler answering ``None`` means the request
    was a notification, which JSON-RPC answers with no body at all.
    """
    raw = await request.body()
    try:
        call = json.loads(raw) if raw else None
    except json.JSONDecodeError as exc:
        return JSONResponse(
            status_code=400, content=jsonrpc_error(None, PARSE_ERROR, f"invalid JSON: {exc}")
        )
    answer = await handler(router, call, budget_units)
    if answer is None:
        return Response(status_code=202)
    status = 400 if _is_malformed(answer) else 200
    return JSONResponse(status_code=status, content=answer)


def _is_malformed(answer: dict[str, Any]) -> bool:
    """Whether a JSON-RPC answer reports a *transport*-level fault, which HTTP reports too.

    A method-level refusal (unknown method, bad params) rides a 200 the way JSON-RPC
    intends; a request that was never a request does not.
    """
    fault = answer.get("error")
    return isinstance(fault, dict) and fault.get("code") in (PARSE_ERROR, INVALID_REQUEST)


async def _generate(
    router: Router, modality: str, payload: dict[str, Any], budget_units: float | None
) -> Response:
    """One response shape for every modality: the upstream body plus the routing report.

    A malformed ``budget_units`` is a 422, not a silently-unbudgeted request — the whole
    point of the ceiling is that a caller who states one is not billed as if they had not.
    """
    try:
        completion = await router.complete(modality, payload, budget_units=budget_units)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(
        content={**completion.response, "agora": completion.routing()},
        headers={
            "X-Agora-Tier": completion.backend.tier,
            "X-Agora-Provider": completion.backend.provider,
            "X-Agora-Model": completion.backend.model,
            "X-Agora-Cost-Units": f"{completion.actual.units:g}",
        },
    )


@app.post("/v1/chat/completions")
async def chat_completions(
    payload: Payload, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    """OpenAI chat completions, served by the first text rung that answers within budget."""
    return await _generate(router, "text", payload, budget_units)


@app.post("/v1/images/generations")
async def image_generations(
    payload: Payload, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    return await _generate(router, "image", payload, budget_units)


@app.post("/v1/audio/speech")
async def audio_speech(
    payload: Payload, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    return await _generate(router, "speech", payload, budget_units)


@app.post("/v1/audio/music-generations")
async def audio_music(
    payload: Payload, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    return await _generate(router, "music", payload, budget_units)


@app.post("/v1/video/generations")
async def video_generations(
    payload: Payload, router: RouterDep, budget_units: BudgetHeader = None
) -> Response:
    return await _generate(router, "video", payload, budget_units)
