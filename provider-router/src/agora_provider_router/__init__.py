"""The agora provider-router.

A gateway to *model backends* — one leaf capability on the bus, never the path other
platforms route through (ADR-0001 decision 1). The tier ladder (paid API key →
mlx-serve → local Ollama/on-disk → deterministic placeholder), its ZERO-SPEND
always-completes invariant, and the OpenAI-compatible surface are ported from Analyzer in
US-AG2; budget ceilings and the KCB manifest follow in US-AG3.
"""

__all__ = ["KCB_VERSION", "ROUTER_IDENTITY", "__version__"]

__version__ = "0.0.0"

#: KINP identity of the router — a capability provider is itself a fabric entity (KCB §2).
ROUTER_IDENTITY = "agora:agent:provider-router"

#: The koine capability-bus version this build speaks. Kept in step with
#: ``schemas/src/index.ts``'s ``SPEC_VERSIONS.kcb``; the cross-language check in
#: ``tests/test_skeleton.py`` fails if they drift.
KCB_VERSION = "0.2.0"
