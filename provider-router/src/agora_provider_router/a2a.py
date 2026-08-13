"""The A2A server surface — the ``invoke`` verb as a task (KCB §4/§6).

The other half of the transport pair (:mod:`~agora_provider_router.mcp` is the first): a
peer reads this router's AgentCard, dials the address the card carries, and sends one
JSON-RPC ``message/send``. It gets back a **completed Task** — this router does no
long-running work, so a task is finished the moment it is answered and there is no task
store to poll. The wire shapes are A2A's own (camelCase keys, ``kind``-tagged parts, a
kebab-case task state), which is what lets the console's A2A wire
(``console/src/kcs/a2a-wire.ts``) read the reply unchanged.

**Which capability.** A2A carries no capability field, so the message says which one it
wants: ``metadata.capability`` (or ``metadata.modality``), else the same key on a ``data``
part, else ``generate.text`` — the reading a conversational message deserves. Text parts
become the prompt; data parts become the rest of the request, so ``size``, ``voice`` and a
``budget_units`` ceiling all reach the ladder exactly as they do on ``/v1``.

**It never relays.** A message addressed to somebody else (``toAgent`` naming another
peer) is *refused*, not forwarded: the fabric's rule is that peers dial each other directly
at the address their own manifest advertises, and nothing routes through a middle (ADR-0001
decisions 3/7). A router that quietly forwarded would make itself exactly the hub the
topology forbids.

**Always completes.** The task state is ``completed`` whenever the ladder answered, which
is always — the placeholder is terminal, offline and free. A JSON-RPC error means the
*request* was malformed, which is the only thing
:meth:`~agora_provider_router.router.Router.complete` refuses.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import ROUTER_IDENTITY
from .cost import BUDGET_HEADER, BUDGET_KEY, parse_ceiling
from .invoke import (
    CAPABILITY_PREFIX,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    Artifact,
    artifacts_of,
    capability_name,
    error,
    fallback_text,
    identifier,
    modality_for,
    payload_for,
    result,
    text_of,
)
from .router import Router

#: Where the A2A surface is served — the AgentCard's own ``url``, and the manifest's
#: ``endpoints.a2a``.
A2A_PATH = "/a2a"

#: The A2A protocol revision this surface answers in. Matches the newest the console's wire
#: advertises (``A2A_PROTOCOL_VERSIONS`` in ``console/src/kcs/a2a-wire.ts``).
A2A_PROTOCOL_VERSION = "1.1"

#: The one method served. ``message/stream``, ``tasks/get`` and the rest are refused by name
#: rather than stubbed: a task here is complete when it is answered, so there is nothing to
#: stream and nothing to look up later.
SEND_METHOD = "message/send"

#: Message-metadata keys that select a capability, in the order they are consulted.
CAPABILITY_KEYS: tuple[str, ...] = ("capability", "modality")

#: The modality a message that names none is read as — a message is conversation by default.
DEFAULT_MODALITY = "text"


async def handle(
    router: Router, request: Any, budget_units: float | None = None
) -> dict[str, Any] | None:
    """Answer one JSON-RPC request. ``None`` means a notification — say nothing back."""
    if not isinstance(request, Mapping):
        return error(None, INVALID_REQUEST, "a JSON-RPC request must be an object")
    method = request.get("method")
    if not isinstance(method, str):
        return error(request.get("id"), INVALID_REQUEST, "a JSON-RPC request must name a method")
    if "id" not in request:
        return None
    call_id = request.get("id")
    if method != SEND_METHOD:
        return error(
            call_id,
            METHOD_NOT_FOUND,
            f"this router serves no A2A method {method!r} — it serves {SEND_METHOD}, and a "
            "task is complete when it is answered, so there is none to stream or fetch later",
        )
    params = request.get("params")
    params = params if isinstance(params, Mapping) else {}
    return await _send(router, call_id, params, budget_units)


async def _send(
    router: Router, call_id: Any, params: Mapping[str, Any], budget_units: float | None
) -> dict[str, Any]:
    raw_message = params.get("message")
    if not isinstance(raw_message, Mapping):
        return error(call_id, INVALID_PARAMS, f"{SEND_METHOD} must carry a message")
    addressee = raw_message.get("toAgent")
    if isinstance(addressee, str) and addressee and addressee != ROUTER_IDENTITY:
        return error(
            call_id,
            INVALID_PARAMS,
            f"this is {ROUTER_IDENTITY}, not {addressee!r} — dial that peer directly at the "
            "address its own manifest advertises; this router relays nothing (ADR-0001 "
            "decision 3)",
        )
    metadata = raw_message.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    arguments, prompt = _read_parts(raw_message)
    try:
        modality = _take_modality(metadata, arguments)
        ceiling = _ceiling(metadata, budget_units)
    except ValueError as exc:
        return error(call_id, INVALID_PARAMS, str(exc))
    payload = payload_for(modality, arguments, prompt)
    try:
        completion = await router.complete(modality, payload, budget_units=ceiling)
    except ValueError as exc:
        return error(call_id, INVALID_PARAMS, str(exc))
    return result(
        call_id,
        _task(modality, payload, completion.response, completion.routing(), raw_message),
    )


def _task(
    modality: str,
    payload: Mapping[str, Any],
    response: Mapping[str, Any],
    routing: Mapping[str, Any],
    request: Mapping[str, Any],
) -> dict[str, Any]:
    """One completion as a finished A2A Task.

    The ids are derived from the request rather than drawn at random, so the same request
    always names the same task — a stateless surface has nothing to hand a random id to,
    and the conformance corpus needs the bytes to be a function of the request.
    """
    context = request.get("contextId")
    task: dict[str, Any] = {
        "id": identifier("task", modality, payload),
        "contextId": context
        if isinstance(context, str) and context
        else identifier("ctx", modality, payload),
        "kind": "task",
        "status": {"state": "completed"},
        "metadata": {"agora": dict(routing), "protocolVersion": A2A_PROTOCOL_VERSION},
    }
    spoken = text_of(response)
    artifacts = artifacts_of(modality, response)
    if not spoken and not artifacts:
        spoken = fallback_text(response)
    if spoken:
        task["status"]["message"] = {
            "role": "agent",
            "parts": [{"kind": "text", "text": spoken}],
            "messageId": identifier("msg", modality, payload),
            "kind": "message",
            "fromAgent": ROUTER_IDENTITY,
        }
    if artifacts:
        task["artifacts"] = [_artifact(modality, a) for a in artifacts]
    return task


def _artifact(modality: str, artifact: Artifact) -> dict[str, Any]:
    """A media output as an A2A Artifact: the bytes as a file part, the digest alongside.

    ``file`` carries bytes rather than a uri because the two are alternatives in A2A and a
    uri would have to be an address this router serves — it serves no artifact-fetch route
    (ADR-0001 decision 3, no promise it cannot answer). The content id rides in the
    artifact's own metadata instead, where it stays verifiable against the bytes.
    """
    return {
        "artifactId": f"artifact-{artifact.digest.replace(':', '-')}",
        "name": capability_name(modality),
        "parts": [
            {
                "kind": "file",
                "file": {
                    "name": artifact.filename,
                    "mimeType": artifact.media_type,
                    "bytes": artifact.data,
                },
            }
        ],
        "metadata": {"digest": artifact.digest},
    }


def _read_parts(message: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """``(arguments, prompt)`` — data parts merged into a request, text parts joined."""
    arguments: dict[str, Any] = {}
    spoken: list[str] = []
    parts = message.get("parts")
    for part in parts if isinstance(parts, list) else []:
        if not isinstance(part, Mapping):
            continue
        if part.get("kind") == "text" and isinstance(part.get("text"), str):
            text = part["text"]
            if text:
                spoken.append(text)
        elif part.get("kind") == "data" and isinstance(part.get("data"), Mapping):
            arguments.update(part["data"])
    return arguments, "\n".join(spoken)


def _take_modality(metadata: Mapping[str, Any], arguments: dict[str, Any]) -> str:
    """The capability this message selects, named in the metadata or on a data part.

    A selector on a data part is *taken out* of the request as it is read: it is agora's own
    extension, like ``budget_units``, naming which ladder to walk rather than anything an
    upstream vendor asked for. Leaving it in would forward a key no provider declares.
    """
    for key in CAPABILITY_KEYS:
        named = metadata.get(key)
        if isinstance(named, str) and named:
            return _capability(named)
    for key in CAPABILITY_KEYS:
        named = arguments.get(key)
        if isinstance(named, str) and named:
            del arguments[key]
            return _capability(named)
    return DEFAULT_MODALITY


def _capability(named: str) -> str:
    """The modality behind a selector, spelled either as a capability or as a bare modality."""
    prefixed = named if named.startswith(CAPABILITY_PREFIX) else f"{CAPABILITY_PREFIX}{named}"
    return modality_for(prefixed)


def _ceiling(metadata: Mapping[str, Any], budget_units: float | None) -> float | None:
    """The KCB §5 spend ceiling a message carried, header spelling or plain.

    The console's A2A wire keys message metadata by the header name the manifest advertises
    (A2A has no headers of its own to put it in), so both spellings are read — and the
    match is case-insensitive, because a header name is.
    """
    lowered = {str(k).lower(): v for k, v in metadata.items()}
    for key in (BUDGET_HEADER.lower(), BUDGET_KEY):
        if key in lowered:
            return parse_ceiling(lowered[key])
    return budget_units
