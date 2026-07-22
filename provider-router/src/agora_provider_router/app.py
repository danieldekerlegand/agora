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

The KCB capability manifest is served at
:data:`~agora_provider_router.manifest.MANIFEST_PATH` for the registry to crawl or the
router to push (KCB §3).

The router is built once from the process environment and cached. Tests that need a
different configuration build their own :class:`Router` and override the :func:`get_router`
dependency, so no test mutates global state.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse

from . import KCB_VERSION, ROUTER_IDENTITY, __version__
from .backends import LOCAL_PROVIDER, MLX_PROVIDER, PAID_PROVIDERS, PAID_VENDORS
from .config import RouterConfig
from .cost import BUDGET_HEADER
from .ladder import MODALITIES, resolve_all
from .manifest import MANIFEST_PATH, capability_manifest
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
def kcb_manifest(router: RouterDep) -> dict[str, Any]:
    """The router's KCB capability manifest (KCB §2) — what the registry indexes."""
    return capability_manifest(router)


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
