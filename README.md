# agora

> The **runtime commons** for koine-conformant systems — reference implementations of the
> contracts, and the ground where conformant peers meet and transact.

`agora` is the sibling to [`koine`](../koine): **koine specifies the contracts, agora implements
them.** It holds the runtime code that belongs inside no single participant — a model gateway, a
discovery registry, an identity resolver, a translation engine, a conformance console — and that
does not belong in the contracts-only koine repo either.

Any project that speaks the koine protocols can use it three ways: **call** a hosted instance,
**self-host** the pieces it wants, or **judge** its own implementation against these as the
reference. There is no membership list — a *participant* is whatever publishes a KCB manifest and
answers on the wire, so everything here is described by **capability**, never by who is calling.

## Quickstart

```sh
make install    # uv sync + npm install (Erlang toolchain optional; its gate skips cleanly)
make check      # run every area's gate — this is what CI and .chief/verify.sh run
make help       # list all targets; `make build` produces the console bundle + router wheel
```

**To use agora from a koine-conformant project**, you never import it as a library — you talk to
it over the wire:

1. **Publish** a KCB manifest at your peer's `/.well-known/kcb-manifest.json` describing the
   capabilities it offers.
2. **Discover** what you need through the registry, which returns **addresses** — it never proxies
   traffic:

   ```ts
   import { createRegistry, registerProviderRouter } from '@agora/registry';

   const registry = createRegistry();
   await registerProviderRouter(registry, 'http://127.0.0.1:8000');

   registry.find({ capability: 'generate.text' });                 // → [{ address, capabilities }]
   registry.path({ from: { entityType: 'mood' }, to: { mediaType: 'audio/wav' } });
   ```

   `find` ranks zero-cost routes first and *unpriced* ones last (unknown is not free); `path`
   chains capabilities across planes and providers and returns the plan plus its projected cost,
   so a caller can gate spend before invoking anything.

3. **Dial** the address you got back directly, over MCP/A2A. Nothing flows through the commons.

## Components

| Component | Where | What it is |
|---|---|---|
| **provider-router** | [`provider-router-erl/`](provider-router-erl/README.md) | OpenAI-compatible model gateway — the *sacred ladder* (paid → mlx-serve → local → placeholder, per modality, always-completes) with cost estimation + budget-ceiling enforcement. A leaf capability, not an inter-participant router. |
| **KCB discovery registry** | [`registry/`](registry/) | The thin capability-bus registry: route-by-lookup, **never proxy** — returns addresses, peers dial each other. |
| **KINP resolver** | [`resolver/`](resolver/) | Reference `resolve` / `reconcile` against a deployment's configured **resolution authority** for real-world entities. |
| **translation engine** | [`translation/`](translation/README.md) | The KMI/KGP translator between a canonical graph shape and the dialects on either side of a bridge; one core, several facades (wasm, PyO3, HTTP leaf). |
| **conformance console** | [`console/`](console/README.md) | A KCS scenario runner + UI that drives conformant peers over their **real** direct connections and asserts cross-plane invariants. An observer, not a hub. |
| **trainer** | [`trainer/`](trainer/README.md) | The **general** KFT `finetune` capability (GPU fine-tuning jobs). Specialized, corpus-specific finetuners run as separate providers on the bus — not here. |
| **schemas / clients** | [`schemas/`](schemas/) · [`clients/`](clients/) | Shared koine manifest schemas / protocol types, and the client libs (`@agora/kcb-client`, `@agora/relation-registry-client`). |

## Layout

Each directory is a **buildable unit with its own gate**:

| Area | Language | Gate |
|---|---|---|
| `provider-router-erl/` | Erlang/OTP (rebar3) | `make check-router-erl` — compile + dialyzer + eunit + ct (incl. the byte-for-byte conformance suite; skips cleanly when Erlang is absent) |
| `provider-router/` | Python (uv) | `make check-provider-router` — ruff + mypy + pytest |
| `trainer/` | Python (uv) | `make check-trainer` — ruff + mypy + pytest |
| `registry/` | TypeScript | `make check-registry` |
| `resolver/` | TypeScript | `make check-resolver` |
| `console/` | TypeScript + React | `make check-console` |
| `schemas/` | TypeScript | `make check-schemas` |
| `clients/*` | TypeScript | `make check-clients` |
| `translation/` | Rust (cargo) | `make check-translation` — build + clippy + test |

Each TypeScript gate is `eslint` + `tsc -p tsconfig.json` + `vitest run`. `make fmt` auto-formats
the Python areas. There are two provider-router areas: the **Erlang app is canonical**; the Python
app stays in-tree as the executable specification it is judged against — see
[`DESIGN.md`](DESIGN.md).

## The koine contracts

Everything here implements a koine spec — read those first:

- **Identity (KINP)** — [`../koine/specs/identity.md`](../koine/specs/identity.md)
- **Knowledge (KGP)** — [`../koine/specs/grounding-pack.md`](../koine/specs/grounding-pack.md)
- **Control plane (KCB)** — [`../koine/specs/capability-bus.md`](../koine/specs/capability-bus.md)
- **Media (KMI)** — [`../koine/specs/media-interchange.md`](../koine/specs/media-interchange.md)
- **Conformance scenarios (KCS)** — [`../koine/specs/conformance-scenario.md`](../koine/specs/conformance-scenario.md)
- **Topology decision** — [`../koine/decisions/ADR-0001-control-plane-topology.md`](../koine/decisions/ADR-0001-control-plane-topology.md)

The shared **relation registry** is koine's *data* (`../koine/registry/`) and agora's *tooling*:
`schemas/src/registry-schema.ts` validates it and `@agora/relation-registry-client` loads it, but
agora never vendors a copy — a copy would be the second source of truth the registry exists to
prevent.

## Design & rationale

The architecture — the provider-router and its always-completes supervision tree, why the stack is
polyglot, the registry/resolver/relation-registry design, and the decision records — is in
[`DESIGN.md`](DESIGN.md).

## License

MIT — see [`LICENSE`](LICENSE). Every buildable unit declares the same license; sharing one across
the tree is what makes a capability here safe to vendor, self-host, or fork.
