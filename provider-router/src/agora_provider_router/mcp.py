"""The MCP server surface — the ``invoke`` verb as a tool call (KCB §4/§6).

A peer that has read this router's manifest dials ``/mcp`` **directly** and drives the
Model Context Protocol handshake over Streamable HTTP: ``initialize`` → ``tools/list`` →
``tools/call``. One tool per capability, named exactly as the manifest names it
(``generate.text``, ``generate.image``, …), so a client that discovered the capability can
call it without a second vocabulary. The console's own MCP wire
(``console/src/kcs/mcp-wire.ts``) is written against this handshake, and it is the client
this surface is judged by.

**Stateless.** No session is issued, so nothing here accumulates per-caller state and no
``mcp-session-id`` is echoed; each POST is a whole exchange. A ``GET`` (the spec's optional
server→client SSE stream) is answered ``405``, which is what the transport spec says a
server that offers no stream must do — an honest refusal rather than a hanging socket.

**It never relays.** Every tool this surface serves is one of *this* router's own
capabilities, dispatched down its own ladder; there is no tool that takes a peer address
and no argument that can make it dial one (ADR-0001 decisions 3/7 — peers connect directly,
nothing routes through a middle). An unknown tool is refused by name rather than forwarded.

**Always completes.** ``tools/call`` inherits the ladder's guarantee: an unconfigured,
unreachable or over-budget rung falls through to the deterministic placeholder, so a tool
call answers rather than failing. ``isError`` is reserved for a malformed *request* — the
only thing :meth:`~agora_provider_router.router.Router.complete` refuses.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import ROUTER_IDENTITY, __version__
from .invoke import (
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PROMPT_KEY,
    Artifact,
    artifacts_of,
    capability_name,
    error,
    fallback_text,
    modality_for,
    payload_for,
    result,
    text_of,
)
from .ladder import MODALITIES
from .router import Router

#: Where the MCP surface is served — the address the manifest advertises as ``endpoints.mcp``.
MCP_PATH = "/mcp"

#: The MCP protocol revisions this server speaks, oldest → newest. A client asking for one of
#: these is answered in its own version; anything else is answered in
#: :data:`LATEST_PROTOCOL_VERSION`, which the spec requires of a server that cannot meet it.
PROTOCOL_VERSIONS: tuple[str, ...] = ("2024-11-05", "2025-03-26", "2025-06-18")
LATEST_PROTOCOL_VERSION: str = PROTOCOL_VERSIONS[-1]

#: The ``_meta`` key the routing report rides under. Prefixed with a domain because MCP
#: reserves unprefixed ``_meta`` names for the protocol itself.
META_ROUTING_KEY = "koine.dev/agora"

#: What a client is told this server is, and what it will not do.
INSTRUCTIONS = (
    "One tool per capability this router offers (KCB §2), each dispatched down its own tier "
    "ladder: paid → mlx-serve → local → a deterministic placeholder, so every call answers. "
    "This surface answers for this router alone — it never relays a call to another peer "
    "(ADR-0001 decision 3); peers are dialed directly at the address their own manifest "
    "advertises. A spend ceiling rides in the X-Agora-Budget-Units header or as a "
    "budget_units argument (KCB §5)."
)


def tools() -> list[dict[str, Any]]:
    """The ``tools/list`` catalogue: one entry per capability, in ladder-modality order."""
    return [_tool(modality) for modality in MODALITIES]


async def handle(
    router: Router, request: Any, budget_units: float | None = None
) -> dict[str, Any] | None:
    """Answer one JSON-RPC request. ``None`` means it was a notification — say nothing back.

    ``budget_units`` is the ceiling the transport carried (the ``X-Agora-Budget-Units``
    header); an argument of the same name overrides it, exactly as a body key beats the
    header on the ``/v1`` routes.
    """
    if not isinstance(request, Mapping):
        return error(None, INVALID_REQUEST, "a JSON-RPC request must be an object")
    method = request.get("method")
    if not isinstance(method, str):
        return error(request.get("id"), INVALID_REQUEST, "a JSON-RPC request must name a method")
    params = request.get("params")
    params = params if isinstance(params, Mapping) else {}
    if "id" not in request:
        # A notification (`notifications/initialized` is the one MCP mandates). Nothing is
        # answered, and an unknown one is ignored rather than refused — a notification has
        # nowhere to carry a refusal to.
        return None
    call_id = request.get("id")
    if method == "initialize":
        return result(call_id, _initialize(params))
    if method == "ping":
        return result(call_id, {})
    if method == "tools/list":
        return result(call_id, {"tools": tools()})
    if method == "tools/call":
        return await _call(router, call_id, params, budget_units)
    return error(call_id, METHOD_NOT_FOUND, f"this router serves no MCP method {method!r}")


def _initialize(params: Mapping[str, Any]) -> dict[str, Any]:
    requested = params.get("protocolVersion")
    version = requested if requested in PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
    return {
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": ROUTER_IDENTITY, "version": __version__},
        "instructions": INSTRUCTIONS,
    }


async def _call(
    router: Router, call_id: Any, params: Mapping[str, Any], budget_units: float | None
) -> dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str):
        return error(call_id, INVALID_PARAMS, "tools/call must name a tool")
    try:
        modality = modality_for(name)
    except ValueError as exc:
        # A protocol-level refusal, not a tool failure: there was no tool to fail.
        return error(call_id, INVALID_PARAMS, str(exc))
    raw = params.get("arguments")
    arguments = raw if isinstance(raw, Mapping) else {}
    payload = payload_for(modality, arguments)
    try:
        completion = await router.complete(modality, payload, budget_units=budget_units)
    except ValueError as exc:
        return result(call_id, _tool_error(str(exc)))
    return result(call_id, _tool_result(modality, completion.response, completion.routing()))


def _tool_result(
    modality: str, response: Mapping[str, Any], routing: Mapping[str, Any]
) -> dict[str, Any]:
    """One completion as MCP content: text as text, media as digested resources."""
    content: list[dict[str, Any]] = []
    spoken = text_of(response)
    if spoken:
        content.append({"type": "text", "text": spoken})
    content.extend(_resource(artifact) for artifact in artifacts_of(modality, response))
    if not content:
        content.append({"type": "text", "text": fallback_text(response)})
    return {"content": content, "_meta": {META_ROUTING_KEY: dict(routing)}}


def _resource(artifact: Artifact) -> dict[str, Any]:
    """A media output as an MCP embedded resource, named by its own content digest."""
    return {
        "type": "resource",
        "resource": {
            "uri": artifact.uri,
            "mimeType": artifact.media_type,
            "blob": artifact.data,
        },
    }


def _tool_error(reason: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": reason}], "isError": True}


def _tool(modality: str) -> dict[str, Any]:
    """One capability as an MCP tool declaration."""
    key = PROMPT_KEY[modality]
    properties: dict[str, Any] = {
        "prompt": {"type": "string", "description": f"what to generate ({modality})"},
        "model": {"type": "string", "description": "a model id, if the caller wants one"},
        "budget_units": {"type": "number", "description": "KCB §5 spend ceiling, in budget units"},
    }
    if key == "messages":
        properties["messages"] = {
            "type": "array",
            "description": "an OpenAI-shaped chat transcript; wins over `prompt` when given",
            "items": {"type": "object"},
        }
    return {
        "name": capability_name(modality),
        "description": (
            f"Generate {modality} down this router's {modality} ladder. Always answers: an "
            "unavailable or over-budget rung falls through to a deterministic placeholder."
        ),
        # Nothing is required: the ladder completes whatever it is handed, and a required
        # field would be a promise about the request that the placeholder tier does not need.
        "inputSchema": {"type": "object", "properties": properties, "additionalProperties": True},
    }
