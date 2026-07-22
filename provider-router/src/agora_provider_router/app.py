"""The router's HTTP surface.

Currently the liveness seam only. US-AG2 mounts the OpenAI-compatible endpoints and
``/doctor`` (the resolved ladder per modality) on this same app.
"""

from fastapi import FastAPI

from . import KCB_VERSION, ROUTER_IDENTITY, __version__

app = FastAPI(title="agora provider-router", version=__version__)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness + identity. Never reports secrets or resolved credentials."""
    return {
        "status": "ok",
        "identity": ROUTER_IDENTITY,
        "version": __version__,
        "kcb_version": KCB_VERSION,
    }
