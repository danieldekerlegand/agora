# agora

> The **runtime commons** for koine-conformant systems — reference implementations of the
> contracts, and the ground where conformant peers meet and transact.

`agora` is the sibling to [`koine`](https://github.com/danieldekerlegand/koine): **koine specifies the contracts, agora implements
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

## Tutorial — wiring a project into agora

A concrete, copy-pasteable walkthrough for a koine-conformant project. It uses the Python
provider-router (easiest to install; the canonical Erlang router answers the byte-identical
contract on the same wire — see [`DESIGN.md`](DESIGN.md)). Every command, port and variable
below is real; nothing here is a placeholder.

### 1. Run the model gateway and point your LLM client at it

The provider-router is **OpenAI-compatible**. Start it — with no keys it runs **zero-spend**,
resolving every modality to the deterministic placeholder tier, so a fresh install answers
immediately and spends nothing:

```sh
pip install agora-provider-router          # or: uv pip install agora-provider-router
agora-provider-router                       # binds AGORA_HOST:AGORA_PORT (default 0.0.0.0:8000)
curl localhost:8000/doctor                  # the resolved ladder per modality — dials nothing
```

Point any OpenAI SDK at `http://localhost:8000/v1` — no code change beyond the base URL:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused")  # key unused on the free tier
resp = client.chat.completions.create(
    model="gpt-4o-mini",                                     # a hint; the ladder resolves the tier
    messages=[{"role": "user", "content": "hello"}],
    extra_headers={"X-Agora-Budget-Units": "0"},             # a spend ceiling of 0 → free tier only
)
print(resp.choices[0].message.content)
# The response carries X-Agora-Tier / X-Agora-Provider / X-Agora-Model / X-Agora-Cost-Units,
# and an `agora` key naming the rung that served it. A stock OpenAI client just ignores them.
```

Opt into a paid or local tier with one environment variable per setting — the router owns the
namespace, `AGORA_PROVIDER_<NAME>_<FIELD>`:

```sh
AGORA_PROVIDER_OPENAI_API_KEY=sk-...  agora-provider-router   # enable the paid OpenAI tier
MLX_SERVE_BASE_URL=http://localhost:8080  agora-provider-router  # enable the mlx-serve tier
OLLAMA_BASE_URL=http://localhost:11434  agora-provider-router    # enable the local tier
```

The ladder order is a *preference*; the per-request `X-Agora-Budget-Units` (or a `budget_units`
body field) is a *constraint* — a rung projected over budget is refused **without being
contacted**, falling through to a cheaper, ultimately zero-cost rung. See
[`provider-router-erl/`](provider-router-erl/README.md) and
[`provider-router/`](provider-router/README.md).

### 2. Discover the capability through the KCB registry

The registry indexes KCB manifests and answers with **addresses** — it never proxies traffic.
Pull the router's own manifest into an index, then `find` it and dial the address yourself:

```ts
import { createRegistry, registerProviderRouter } from '@agora/registry';

const registry = createRegistry();
await registerProviderRouter(registry, 'http://127.0.0.1:8000');   // crawls /.well-known/kcb-manifest.json

const [match] = registry.find({ capability: 'generate.text' });    // ranked cheapest-first
// match.address is the whole point — dial it directly (it is the http://…/v1 base above).
console.log(match.identity, match.address, match.estUnits, match.unpriced);

// Chain capabilities across providers and read the projected cost before spending anything:
const plan = registry.path({ from: { plane: 'knowledge' }, to: { plane: 'media' } });
console.log(plan?.steps.map((s) => s.capability), plan?.projectedUnits);
```

Your *own* peer joins the same way: serve a KCB manifest at
`/.well-known/kcb-manifest.json` describing what it offers, then `registerFromWellKnown(registry,
'https://your-peer.example')`. Discovery returns its address; callers dial it directly. Details in
[`registry/`](registry/README.md).

### 3. Prove it end-to-end with a conformance scenario

The console runs a **KCS scenario** against the *real* connections and asserts cross-plane
invariants — it observes, it is not a hub. Bring up the UI (it discovers the router at
`127.0.0.1:8000`) and run the shipped round-trip:

```sh
npm run dev -w @agora/console
# In the UI, run `kcs:provider-router-roundtrip`: discover the router, dial it under a
# zero-unit budget ceiling, and assert the zero-spend tier served it for nothing.
```

There is no scenario CLI binary — to run one in code, import `runConformance`
(`console/src/commons.ts`) and `findScenario` (`console/src/scenarios/library.ts`).
`runConformance` crawls the router into a registry, runs the scenario, and returns a
content-addressed report:

```ts
import { runConformance } from './console/src/commons';
import { findScenario } from './console/src/scenarios/library';

const run = await runConformance(findScenario('kcs:provider-router-roundtrip')!);
console.log(run.report.address, run.report.verdict);   // a citable, archivable sha256-… report
```

The two scenarios that ship (`kcs:provider-router-roundtrip`, `kcs:sample-pipeline`) are
**illustrative, not normative** — write your own against your own peers by KINP identity. See
[`console/`](console/README.md).

## Components

| Component | Where | What it is |
|---|---|---|
| **provider-router** | [`provider-router-erl/`](provider-router-erl/README.md) | OpenAI-compatible model gateway — the *sacred ladder* (paid → mlx-serve → local → placeholder, per modality, always-completes) with cost estimation + budget-ceiling enforcement. A leaf capability, not an inter-participant router. |
| **KCB discovery registry** | [`registry/`](registry/README.md) | The thin capability-bus registry: route-by-lookup, **never proxy** — returns addresses, peers dial each other. |
| **KINP resolver** | [`resolver/`](resolver/README.md) | Reference `resolve` / `reconcile` against a deployment's configured **resolution authority** for real-world entities. |
| **translation engine** | [`translation/`](translation/README.md) | The KMI/KGP translator between a canonical graph shape and the dialects on either side of a bridge; one core, several facades (wasm, PyO3, HTTP leaf). |
| **conformance console** | [`console/`](console/README.md) | A KCS scenario runner + UI that drives conformant peers over their **real** direct connections and asserts cross-plane invariants. An observer, not a hub. |
| **trainer** | [`trainer/`](trainer/README.md) | The **general** KFT `finetune` capability (GPU fine-tuning jobs). Specialized, corpus-specific finetuners run as separate providers on the bus — not here. |
| **schemas / clients** | [`schemas/`](schemas/README.md) · [`kcb-client/`](clients/kcb-client/README.md) · [`relation-registry-client/`](clients/relation-registry-client/README.md) | Shared koine manifest schemas / protocol types, and the client libs (`@agora/kcb-client`, `@agora/relation-registry-client`). |

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

- **Identity (KINP)** — [`koine/specs/identity.md`](https://github.com/danieldekerlegand/koine/blob/main/specs/identity.md)
- **Knowledge (KGP)** — [`koine/specs/grounding-pack.md`](https://github.com/danieldekerlegand/koine/blob/main/specs/grounding-pack.md)
- **Control plane (KCB)** — [`koine/specs/capability-bus.md`](https://github.com/danieldekerlegand/koine/blob/main/specs/capability-bus.md)
- **Media (KMI)** — [`koine/specs/media-interchange.md`](https://github.com/danieldekerlegand/koine/blob/main/specs/media-interchange.md)
- **Conformance scenarios (KCS)** — [`koine/specs/conformance-scenario.md`](https://github.com/danieldekerlegand/koine/blob/main/specs/conformance-scenario.md)
- **Topology decision** — [`koine/decisions/ADR-0001-control-plane-topology.md`](https://github.com/danieldekerlegand/koine/blob/main/decisions/ADR-0001-control-plane-topology.md)

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
