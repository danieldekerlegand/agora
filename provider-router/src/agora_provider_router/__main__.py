"""Console entry point — boot the OpenAI-compatible surface under uvicorn.

Both the ``agora-provider-router`` script (declared in ``[project.scripts]``) and
``python -m agora_provider_router`` land in :func:`main`, so a bare install can serve
the app with no repo-root Makefile in sight. Host and port are read from the
environment (``AGORA_HOST`` / ``AGORA_PORT``) so a container binds without a code
change; the always-completes / ZERO-SPEND default (no keys, no local servers →
placeholder) means launching one immediately is safe — it spends nothing.
"""

from __future__ import annotations

import os


def main() -> None:
    """Serve :data:`agora_provider_router.app.app` on ``AGORA_HOST``:``AGORA_PORT``."""
    import uvicorn

    host = os.environ.get("AGORA_HOST", "0.0.0.0")  # a service binds to all interfaces by default
    port = int(os.environ.get("AGORA_PORT", "8000"))
    uvicorn.run("agora_provider_router.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
