"""Console entry point — boot the trainer's HTTP surface under uvicorn.

Both the ``agora-trainer`` script (declared in ``[project.scripts]``) and
``python -m agora_trainer`` land in :func:`main`, so a bare install can serve the app with
no repo-root Makefile in sight. Host and port are read from the environment
(``AGORA_TRAINER_HOST`` / ``AGORA_TRAINER_PORT``) so a container binds without a code change;
the trainer's default port is 8001 — one above the provider-router's — because it is a
distinct service (ADR-0001 decision 1).
"""

from __future__ import annotations

import os


def main() -> None:
    """Serve :data:`agora_trainer.app.app` on ``AGORA_TRAINER_HOST``:``AGORA_TRAINER_PORT``."""
    import uvicorn

    host = os.environ.get("AGORA_TRAINER_HOST", "0.0.0.0")  # a service binds all interfaces
    port = int(os.environ.get("AGORA_TRAINER_PORT", "8001"))
    uvicorn.run("agora_trainer.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
