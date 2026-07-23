"""The agora general **finetune trainer**.

The runtime implementation of the koine fine-tuning profile (KFT,
``koine/specs/fine-tuning.md``) — a leaf capability on the bus that consumes training data
(KGP knowledge / KMI media) plus a base-model entity (KINP) and produces a new model entity
(KINP) plus weight assets (KMI), orchestrated as a `finetune` capability (KCB).

Per [ADR-0001](../../decisions/ADR-0001-control-plane-topology.md) decision 1 — *two distinct
routers, never merged* — this is deliberately **separate** from the provider-router: the
provider-router routes *inference* to model backends; the trainer runs long-lived, stateful,
GPU *fine-tuning* jobs. They share the bus, not a process, and this package imports nothing
from ``agora_provider_router``.

The pieces, in dependency order — this module stays constants-only so any of them can import
it:

* :mod:`~agora_trainer.modality` — the KFT §3.1 modality × method vocabulary this general
  provider serves
* :mod:`~agora_trainer.config` — the ``AGORA_*`` settings the trainer reads
* :mod:`~agora_trainer.manifest` — the KCB `finetune` capability manifest (KCB §2, KFT §2)
* :mod:`~agora_trainer.app` — the HTTP surface (``/health``, the agent card, the manifest)
"""

import os

__all__ = [
    "KCB_VERSION",
    "KFT_VERSION",
    "TRAINER_IDENTITY",
    "TRAINER_IDENTITY_ENV_VAR",
    "__version__",
]

__version__ = "0.1.0"

#: Env var overriding the trainer's KINP identity; unset keeps the default.
TRAINER_IDENTITY_ENV_VAR = "AGORA_TRAINER_IDENTITY"

#: The identity a bare deployment reports — a capability provider is itself a fabric entity
#: (KCB §2). Distinct from ``agora:agent:provider-router`` on purpose (ADR-0001 decision 1).
_DEFAULT_TRAINER_IDENTITY = "agora:agent:trainer"

#: KINP identity of the trainer. Overridable so a separate deployment can name itself.
TRAINER_IDENTITY = os.environ.get(TRAINER_IDENTITY_ENV_VAR, "").strip() or _DEFAULT_TRAINER_IDENTITY

#: The koine capability-bus version this build speaks. Kept in step with
#: ``schemas/src/versions.ts``'s ``SPEC_VERSIONS.kcb``; the cross-language check in
#: ``tests/test_skeleton.py`` fails if they drift (the same pin the provider-router keeps).
KCB_VERSION = "0.2.0"

#: The koine fine-tuning profile version this trainer implements (``koine/specs/fine-tuning.md``).
KFT_VERSION = "0.3.0"
