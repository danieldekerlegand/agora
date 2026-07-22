"""The terminal tier: deterministic, offline, free.

The placeholder is what makes the ladder *always complete*. It never touches the network,
never spends, and is a pure function of the request — the same payload yields byte-identical
output on any machine, which is what lets a conformance scenario (US-AG5) assert on it.

Its responses are OpenAI-shaped so a caller cannot tell the tier apart from the envelope
alone; the resolved tier is reported out of band (``agora``/``X-Agora-Tier``) rather than by
mangling the response body. Every placeholder artifact is *self-declaring* — the text says
so, the media carries ``"placeholder": true`` — so it can never be mistaken for real output.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

#: Bytes of synthetic payload a media placeholder emits. Small on purpose: this is a
#: stand-in artifact, not a render.
_MEDIA_BYTES = 256

#: modality → the media type of the stand-in artifact (KMI §2 ``media_type``).
MEDIA_TYPES: dict[str, str] = {
    "image": "image/png",
    "speech": "audio/wav",
    "music": "audio/wav",
    "video": "video/mp4",
}


def digest(payload: dict[str, Any]) -> str:
    """A stable hex digest of ``payload`` — key order and float formatting normalised."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def complete(modality: str, payload: dict[str, Any], model: str) -> dict[str, Any]:
    """The deterministic response for ``modality``. Never raises, never spends."""
    if modality == "text":
        return _text(payload, model)
    return _media(modality, payload, model)


def _text(payload: dict[str, Any], model: str) -> dict[str, Any]:
    fingerprint = digest(payload)
    content = (
        "[agora placeholder] no paid, mlx-serve or local backend was available; this is a "
        f"deterministic stand-in for request {fingerprint[:12]}."
    )
    return {
        "id": f"chatcmpl-placeholder-{fingerprint[:16]}",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        # Zero, not absent: the placeholder consumes no tokens, and a cost estimator
        # (US-AG3) must be able to read that off the response like any other tier's.
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _media(modality: str, payload: dict[str, Any], model: str) -> dict[str, Any]:
    fingerprint = digest(payload)
    seed = hashlib.sha256(fingerprint.encode("utf-8")).digest()
    body = (seed * (_MEDIA_BYTES // len(seed) + 1))[:_MEDIA_BYTES]
    return {
        "id": f"gen-placeholder-{fingerprint[:16]}",
        "object": f"{modality}.generation",
        "created": 0,
        "model": model,
        "data": [
            {
                "b64_json": base64.b64encode(body).decode("ascii"),
                "media_type": MEDIA_TYPES.get(modality, "application/octet-stream"),
                "placeholder": True,
                "digest": fingerprint,
            }
        ],
    }
