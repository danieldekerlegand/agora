# agora

> A ready-to-run toolkit for connecting independent AI systems: an OpenAI-compatible model
> gateway, a service-discovery registry, an identity resolver, a data translator, and a
> conformance tester.

agora is a collection of small, self-contained services that let separate AI systems find and
call each other over the network without hand-wiring a bridge between every pair. It is for anyone
building services that need to talk to models and to each other — start by running the pieces you
want, self-host the ones you need, or use them as a reference to test your own implementation
against.

The fastest thing it gives you today is a **model gateway that runs for free out of the box**: an
OpenAI-compatible endpoint you can point any existing client at, that answers immediately with no
API key and never surprises you with a bill. Everything else builds outward from there.

## The problem it solves

Connect *N* AI systems to each other pairwise and you end up writing roughly *N²* one-off
integrations — every new system has to learn every other system's private address, format, and
quirks. And connecting to models directly means scattering vendor SDKs, API keys, and
cost-control logic across every service that needs a completion.

agora replaces both with a shared runtime. Services advertise what they can do; callers discover
them by *capability* instead of by hard-coded address; and a single gateway sits in front of every
model backend with one uniform interface and one place to cap spending. Add a new participant and
it learns *one* set of conventions, not one per peer.

## How it works

agora is built on a few deliberate ideas. None of them require prior knowledge to use.

- **Addresses, not proxies.** The discovery registry is a phone book, not a switchboard. You ask
  it "who can do X?" and it returns an *address*; you then connect to that service **directly**.
  Your actual traffic never flows through agora. This keeps the shared layer thin and the
  cleverness at the edges.

- **Everything is described by capability, never by name.** There is no membership list. A
  participant is simply anything that publishes a manifest describing its capabilities and answers
  on the wire. agora never needs to know *who* is calling — only *what* is asked for.

- **A model gateway that always completes.** The gateway (called the **provider-router**) owns a
  fallback chain — paid vendor → local model server → local model → a built-in deterministic
  placeholder. It walks the chain until a rung can serve the request, and the bottom rung can
  never fail. With no keys configured, every request lands on the free placeholder tier, so a
  fresh install works and spends nothing.

- **Spend is capped before anything is contacted.** Each request can carry a budget ceiling. Any
  tier whose projected cost exceeds it is skipped *without being called*, falling through to a
  cheaper — ultimately free — option. Cost control is a property of the system, not something each
  caller reimplements.

- **Proof over promises.** A conformance console runs test scenarios against the *real*
  connections between services and checks that the guarantees held, producing a citable report.

agora provides *reference implementations* of a set of open interchange contracts published in a
separate, public project called [koine](https://github.com/danieldekerlegand/koine). You do not
need koine to use agora — the services here run and are useful on their own. koine is where to
look if you want to understand the contracts in the abstract or implement one yourself; see
[Going deeper](#going-deeper).

## Getting started

In a hurry? **[The quickstart](docs/quickstart.md)** goes from installing the client SDK to
running a discoverable peer and making your first call against it, in about five minutes.

Otherwise, clone the repo and install every area's dependencies:

```sh
make install    # uv sync + npm install (the Erlang toolchain is optional; its gate skips cleanly)
make check      # run every area's quality gate — this is what CI runs
make help       # list all targets; `make build` produces the console bundle + router wheel
```

The best first success is the zero-spend model gateway. Install and start it, then point any
OpenAI client at it:

```sh
pip install agora-provider-router          # or: uv pip install agora-provider-router
agora-provider-router                       # binds AGORA_HOST:AGORA_PORT (default 0.0.0.0:8000)
curl localhost:8000/doctor                  # shows the resolved fallback chain per modality — dials nothing
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused")  # key unused on the free tier
resp = client.chat.completions.create(
    model="gpt-4o-mini",                                     # a hint; the router resolves the actual tier
    messages=[{"role": "user", "content": "hello"}],
    extra_headers={"X-Agora-Budget-Units": "0"},             # a spend ceiling of 0 → free tier only
)
print(resp.choices[0].message.content)
```

Enable a paid or local tier with one environment variable per setting:

```sh
AGORA_PROVIDER_OPENAI_API_KEY=sk-...  agora-provider-router     # enable the paid OpenAI tier
OLLAMA_BASE_URL=http://localhost:11434  agora-provider-router    # enable a local ollama tier
```

## Learn by example

Start here — install the SDK, run a participant, make your first call, every command real:

- **[Quickstart: install to first call](docs/quickstart.md)**

The three-step walkthrough takes a project from nothing to fully connected — **run** the gateway,
**discover** a capability through the registry, and **prove** the round-trip with a conformance
scenario — with every command explained:

- **[Wiring a project into agora](docs/walkthrough-wiring-a-project.md)**

To go the other way — become a peer others can find — copy the ~20-line starter, which serves an
AgentCard carrying its KCB manifest and answers on the wire:

- **[The participant starter](examples/participant-starter/README.md)**

## Components

Each component is an independent service you can run on its own.

| Component | Where | What it is |
|---|---|---|
| **provider-router** | [`provider-router-erl/`](provider-router-erl/README.md) | The OpenAI-compatible model gateway. Owns the always-completes fallback chain (paid → local model server → local model → deterministic placeholder), per modality, with cost estimation and budget-ceiling enforcement. |
| **discovery registry** | [`registry/`](registry/README.md) | The service phone book: `find` a capability, get back an **address**. It ranks routes cheapest-first, can chain capabilities across providers, and **never relays traffic**. |
| **identity resolver** | [`resolver/`](resolver/README.md) | Resolves and reconciles entity identifiers against a deployment's configured authority — the canonical store for who's who. |
| **knowledge sync** | [`knowledge/`](knowledge/README.md) | The KGP data-plane bridge: any producer's claims, checked against the shared relation vocabulary and the license/egress/dialect gates, delivered to a KGP consumer as a content-addressed grounding pack. A conduit with a gate — it stores nothing. |
| **translation engine** | [`translation/`](translation/README.md) | Translates knowledge and media between a canonical graph shape and the formats on either side of a bridge. One core, several front-ends (WebAssembly, native Python binding, HTTP service). |
| **conformance console** | [`console/`](console/README.md) | A scenario runner + UI that drives real connections between services and asserts the guarantees held. An observer, not a hub. |
| **trainer** | [`trainer/`](trainer/README.md) | The general-purpose model fine-tuning capability (GPU fine-tuning jobs). Specialized, corpus-specific finetuners run as their own services. |
| **client SDK** | [`clients/sdk/`](clients/sdk/README.md) | `@agora/sdk` — one install for a participant: serve an AgentCard carrying a KCB manifest, find a peer, get an **address** you dial yourself. |
| **schemas** | [`schemas/`](schemas/README.md) | `@agora/schemas` — the shared manifest schemas and protocol types every area (and the SDK) is built on. |

## Layout

Each directory is a **buildable unit with its own quality gate**. agora is intentionally polyglot
(see [Going deeper](#going-deeper) for why) — the language of each service is an internal detail,
since everything is reached over the wire, never imported across a language boundary.

| Area | Language | Gate |
|---|---|---|
| `provider-router-erl/` | Erlang/OTP (rebar3) | `make check-router-erl` — the canonical router; compile + dialyzer + eunit + ct (skips cleanly when Erlang is absent) |
| `provider-router/` | Python (uv) | `make check-provider-router` — ruff + mypy + pytest |
| `trainer/` | Python (uv) | `make check-trainer` — ruff + mypy + pytest |
| `registry/` | TypeScript | `make check-registry` |
| `resolver/` | TypeScript | `make check-resolver` |
| `knowledge/` | TypeScript | `make check-knowledge` — the KGP knowledge-sync bridge |
| `console/` | TypeScript + React | `make check-console` |
| `schemas/` | TypeScript | `make check-schemas` |
| `clients/sdk/` | TypeScript | `make check-clients` — the published client SDK (`make build` emits its `dist/`) |
| `examples/participant-starter/` | TypeScript | `make check-examples` — the copy-and-run participant starter |
| `translation/` | Rust (cargo) | `make check-translation` — build + clippy + test |

There are two provider-router areas: the **Erlang app is the canonical one you deploy**, and the
**Python app stays in the tree as the executable specification** the Erlang app is tested against,
byte for byte. A change to the router's external behavior must land in both or in neither. That
outcome — Erlang as the canonical router — is the decision of ADR-0004 (a private deployment ADR:
the deployment-history records ADR-0002–0004 live in the operator's private integration repo, so
there is no public file to link). The engineering reasoning is in [`DESIGN.md`](DESIGN.md).

## Status

Every component above is implemented and gated — `make check` runs each area's quality gate and is
what CI runs — but a few edges are honestly still in progress: the conformance console's
control-plane telemetry reader is provisional, so a conformance predicate that needs emitted
telemetry currently reports `pending` rather than passing; the trainer's general provider is
implemented and gated, but its live endpoints for training telemetry (KFT §6), model export
(§5.3), and the model registry (§8) are not yet served; and the Erlang-router cutover keeps the
Python router in the tree as the executable specification until its preconditions land. The full
picture — what is done, what is in flight, and the phased plan — is [`ROADMAP.md`](ROADMAP.md).
Also on that roadmap (Phase G) is **Agora Studio**, the planned topology/observability UI: a live
graph of participants and their MCP/A2A connections, with on-the-wire message viewing, built over
the registry and resolver surfaces.

## Going deeper

- **[`DESIGN.md`](DESIGN.md)** — the architecture and the *why*: the always-completes supervision
  tree, why the stack is polyglot, and the design of the registry, resolver, and translation
  surfaces.

- **[`docs/prior-art.md`](docs/prior-art.md)** — how each component relates to existing tools
  (LLM gateways like LiteLLM, agent registries, the reconciliation API): what agora deliberately
  reuses versus what it adds.

- **[koine](https://github.com/danieldekerlegand/koine)** — the open specifications agora
  implements, if you want to understand the contracts in the abstract or build your own conformant
  system. koine is *specification only* (no code); agora is the runtime. The core specs:

  | Spec | What it covers |
  |---|---|
  | [Identity & Namespace](https://github.com/danieldekerlegand/koine/blob/main/specs/identity.md) (KINP) | How every entity gets a stable, shared name |
  | [Grounding-Pack](https://github.com/danieldekerlegand/koine/blob/main/specs/grounding-pack.md) (KGP) | How knowledge (facts, graphs) is exchanged |
  | [Capability-Bus](https://github.com/danieldekerlegand/koine/blob/main/specs/capability-bus.md) (KCB) | How a service advertises a capability and another discovers and calls it |
  | [Media-Interchange](https://github.com/danieldekerlegand/koine/blob/main/specs/media-interchange.md) (KMI) | How media (assets, edit lists, metadata) is exchanged |
  | [Conformance-Scenario](https://github.com/danieldekerlegand/koine/blob/main/specs/conformance-scenario.md) (KCS) | The test format for proving an implementation is correct |

  The design decision that created this repo — a thin shared commons with direct-dial peers and a
  registry that returns addresses — is
  [ADR-0001](https://github.com/danieldekerlegand/koine/blob/main/decisions/ADR-0001-control-plane-topology.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Every buildable unit declares the same license; sharing one
license across the tree is what makes any capability here safe to vendor, self-host, or fork.
