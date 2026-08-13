"""One invocation, three transports — what ``invoke`` means off the OpenAI wire.

KCB §4 maps the **invoke** verb onto an MCP tool call and an A2A task
(:mod:`~agora_provider_router.mcp`, :mod:`~agora_provider_router.a2a`). Both arrive
loosely shaped — a tool's ``arguments`` object, a message's text and data parts — and both
have to end up calling the same :meth:`~agora_provider_router.router.Router.complete` the
``/v1`` routes call, with the same ladder, the same ceiling and the same always-completes
contract. This module is that translation, kept in one place so the two transports cannot
disagree about what ``generate.image`` takes or what came back.

Three rules it holds to:

* **The capability name is the modality.** ``generate.<modality>`` is what the manifest
  advertises (KCB §2), so it is what an MCP tool is named and what an A2A message selects.
  There is no second vocabulary to keep in step.
* **Ids are derived, never drawn.** An MCP resource uri, an A2A task id and an artifact id
  are all functions of the request or of the bytes they name. A random id would make two
  identical requests differ on the wire, and the byte-for-byte conformance corpus
  (``apr_conformance_SUITE``) could not hold both routers to one surface.
* **Artifacts travel with a content digest.** ``sha256:<hex>`` over the decoded bytes —
  self-verifying (KCB §4 ``fetch``, delta G), and *not* the placeholder's own ``digest``
  field, which fingerprints the request rather than the response.

Nothing here dials anything or reaches for the network; it is pure shape.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .ladder import MODALITIES
from .placeholder import MEDIA_TYPES

#: Capability names are ``generate.<modality>`` — the KCB §2 manifest's own vocabulary.
CAPABILITY_PREFIX = "generate."

#: Every capability this router offers, in ladder-modality order.
CAPABILITIES: tuple[str, ...] = tuple(f"{CAPABILITY_PREFIX}{m}" for m in MODALITIES)

#: modality → the OpenAI-shaped key its prompt belongs under, once translated.
PROMPT_KEY: dict[str, str] = {
    "text": "messages",
    "image": "prompt",
    "speech": "input",
    "music": "prompt",
    "video": "prompt",
}

#: Argument keys a caller may hand a prompt under. A transport client that knows only the
#: manifest's port shapes (``prompt-text``, ``chat-messages``) is as welcome as one that
#: knows OpenAI's spelling; whichever it uses lands under :data:`PROMPT_KEY`.
PROMPT_ALIASES: tuple[str, ...] = ("prompt", "input", "text", "prompt-text", "chat-messages")

#: The scheme of an artifact reference. A content id, deliberately *not* an ``http`` address:
#: this router serves no CAS fetch route, and a manifest-shaped promise it cannot answer is
#: worse than none (ADR-0001 decision 3). The bytes ride alongside it.
ARTIFACT_SCHEME = "agora:artifact:"


def capability_name(modality: str) -> str:
    """The KCB capability a modality is invoked as."""
    return f"{CAPABILITY_PREFIX}{modality}"


def modality_for(capability: str) -> str:
    """The modality a capability name selects. ``ValueError`` names the ones that exist."""
    named = capability.startswith(CAPABILITY_PREFIX)
    modality = capability[len(CAPABILITY_PREFIX) :] if named else ""
    if modality not in MODALITIES:
        raise ValueError(f"unknown capability {capability!r} — this router offers {known()}")
    return modality


def known() -> str:
    """The capability vocabulary, for a refusal message."""
    return ", ".join(CAPABILITIES)


def payload_for(modality: str, arguments: Mapping[str, Any], prompt: str = "") -> dict[str, Any]:
    """The OpenAI-shaped body ``arguments`` (plus any ``prompt``) mean for ``modality``.

    Every key that is not a prompt alias survives verbatim — ``model``, ``size``, ``voice``,
    ``budget_units`` — so a caller on MCP or A2A can steer a generation exactly as one on
    ``/v1`` can. An explicitly OpenAI-spelled value always wins over a translated alias, and
    a request that carries no prompt at all is passed on as-is rather than invented for.
    """
    key = PROMPT_KEY[modality]
    payload = {k: v for k, v in arguments.items() if k not in PROMPT_ALIASES}
    if key in arguments:
        payload[key] = arguments[key]
        return payload
    spoken = prompt or _first_string(arguments, PROMPT_ALIASES)
    if spoken:
        payload[key] = [{"role": "user", "content": spoken}] if modality == "text" else spoken
    return payload


def identifier(prefix: str, modality: str, payload: Mapping[str, Any]) -> str:
    """A stable id for one request — the same request always names itself the same way."""
    fingerprint = hashlib.sha256(
        json.dumps(
            {"modality": modality, "payload": dict(payload)},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    return f"{prefix}-{fingerprint[:16]}"


@dataclass(frozen=True)
class Artifact:
    """One media-plane output of a generation, by media type, digest and inline bytes."""

    media_type: str
    #: ``sha256:<hex>`` over the decoded bytes — integrity self-verifies (KCB §4, delta G).
    digest: str
    #: The bytes, base64 as the upstream body carried them.
    data: str

    @property
    def uri(self) -> str:
        """The content id a transport references this artifact by."""
        return f"{ARTIFACT_SCHEME}{self.digest}"

    @property
    def filename(self) -> str:
        """A file name a client can save it under, keyed by its own digest."""
        suffix = self.media_type.rsplit("/", 1)[-1] or "bin"
        return f"{self.digest.replace(':', '-')}.{suffix}"


def text_of(response: Mapping[str, Any]) -> str:
    """The text an OpenAI-shaped response carries, joined across its choices."""
    choices = response.get("choices")
    if not isinstance(choices, list):
        return ""
    spoken: list[str] = []
    for choice in choices:
        if not isinstance(choice, Mapping):
            continue
        message = choice.get("message")
        content = message.get("content") if isinstance(message, Mapping) else choice.get("text")
        if isinstance(content, str) and content:
            spoken.append(content)
    return "\n".join(spoken)


def artifacts_of(modality: str, response: Mapping[str, Any]) -> list[Artifact]:
    """The inline media outputs of a response, digested. Entries without bytes are skipped."""
    data = response.get("data")
    if not isinstance(data, list):
        return []
    artifacts: list[Artifact] = []
    for entry in data:
        if not isinstance(entry, Mapping):
            continue
        encoded = entry.get("b64_json")
        if not isinstance(encoded, str):
            continue
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError:
            # Not decodable, so not describable — a digest over bytes we do not have would
            # be a lie. The upstream body still reaches the caller via the fallback below.
            continue
        media_type = entry.get("media_type")
        artifacts.append(
            Artifact(
                media_type=str(media_type)
                if isinstance(media_type, str) and media_type
                else MEDIA_TYPES.get(modality, "application/octet-stream"),
                digest=f"sha256:{hashlib.sha256(raw).hexdigest()}",
                data=encoded,
            )
        )
    return artifacts


def fallback_text(response: Mapping[str, Any]) -> str:
    """The upstream body itself, when it carried neither text nor inline artifacts.

    A backend that answers with hosted URLs rather than bytes (a real image vendor does)
    would otherwise reach an MCP or A2A caller as an empty result. Handing back what the
    provider actually said is the honest degrade; the keys are sorted so the rendering is
    the same on every host and in every language.
    """
    return json.dumps(dict(response), sort_keys=True, separators=(",", ":"), default=str)


# --- JSON-RPC ----------------------------------------------------------------------
# Both transports are JSON-RPC 2.0 over one POST, so the envelope is shared: a transport
# that spelled an error differently from its sibling would make the same refusal read as two
# different contracts.

#: The JSON-RPC error codes both surfaces answer with, as the protocol spells them.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602


def result(call_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """A JSON-RPC success envelope."""
    return {"jsonrpc": "2.0", "id": call_id, "result": payload}


def error(call_id: Any, code: int, message: str) -> dict[str, Any]:
    """A JSON-RPC failure envelope. The reason is the provider's own, never a bare code."""
    return {"jsonrpc": "2.0", "id": call_id, "error": {"code": code, "message": message}}


def _first_string(arguments: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = arguments.get(key)
        if isinstance(value, str) and value:
            return value
    return ""
