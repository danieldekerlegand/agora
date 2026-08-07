# Walkthrough: wiring a project into agora

This is a worked example of using agora end to end. It takes a project that has never touched
the commons and connects it in three moves: **run** the model gateway and call it, **discover** a
capability through the registry, and **prove** the whole thing works with a conformance scenario.
It is the best way to build intuition for how the pieces fit, because a single pass touches every
surface — the gateway, the discovery registry, and the conformance console — the way a real
integration does.

Every command, port, and variable below is real; nothing here is a placeholder. The examples use
the Python provider-router because it is the easiest to install with one `pip` command. The
canonical Erlang router answers the byte-identical contract on the same wire, so anything you
learn here transfers unchanged — see [`../DESIGN.md`](../DESIGN.md) for why there are two.

> **Before you start**, it helps to know two terms this walkthrough leans on. A **capability** is
> something a service can do, described by what it consumes and produces (for example,
> "text in → text out"). The **KCB manifest** (Koine Capability-Bus manifest) is the small
> document a service publishes to advertise its capabilities so others can find it. You do not
> need to have read any specification to follow along.

## Step 1 — Run the model gateway and point your LLM client at it

The **provider-router** is an OpenAI-compatible model gateway: any tool that speaks the OpenAI API
can talk to it with no change beyond the base URL. Start it — with no API keys configured it runs
**zero-spend**, resolving every request to a deterministic placeholder response, so a fresh
install answers immediately and costs nothing:

```sh
pip install agora-provider-router          # or: uv pip install agora-provider-router
agora-provider-router                       # binds AGORA_HOST:AGORA_PORT (default 0.0.0.0:8000)
curl localhost:8000/doctor                  # shows the resolved fallback chain per modality — dials nothing
```

Now point any OpenAI SDK at `http://localhost:8000/v1`:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused")  # key unused on the free tier
resp = client.chat.completions.create(
    model="gpt-4o-mini",                                     # a hint; the router resolves the actual tier
    messages=[{"role": "user", "content": "hello"}],
    extra_headers={"X-Agora-Budget-Units": "0"},             # a spend ceiling of 0 → free tier only
)
print(resp.choices[0].message.content)
# The response carries X-Agora-Tier / X-Agora-Provider / X-Agora-Model / X-Agora-Cost-Units
# headers naming the rung that served it. A stock OpenAI client just ignores them.
```

**What just happened.** The router owns a *fallback chain* — paid vendor → local `mlx-serve`
→ local `ollama` → deterministic placeholder — and walks it top to bottom until a rung can serve
the request. With no keys, only the bottom rung is enabled, so every call lands there and spends
nothing. The chain's whole promise is that it *always completes*: there is always a terminal rung
that cannot fail.

To enable a paid or local tier, set one environment variable per setting. The router owns the
namespace `AGORA_PROVIDER_<NAME>_<FIELD>`:

```sh
AGORA_PROVIDER_OPENAI_API_KEY=sk-...  agora-provider-router     # enable the paid OpenAI tier
MLX_SERVE_BASE_URL=http://localhost:8080  agora-provider-router  # enable the local mlx-serve tier
OLLAMA_BASE_URL=http://localhost:11434  agora-provider-router    # enable the local ollama tier
```

The chain order is a *preference*; the per-request budget ceiling is a *constraint*. Send
`X-Agora-Budget-Units` (or a `budget_units` field in the request body) and any rung whose
projected cost exceeds it is **refused without being contacted**, falling through to a cheaper —
ultimately zero-cost — rung. That is how a caller caps spend before a single vendor call is made.
Details in [`../provider-router/README.md`](../provider-router/README.md) and
[`../provider-router-erl/README.md`](../provider-router-erl/README.md).

## Step 2 — Discover the capability through the registry

You could hard-code `http://localhost:8000/v1` into your client, but then you are back to
point-to-point wiring. The **registry** removes that: services publish what they can do, and a
caller *finds* one by capability instead of by address. Crucially, the registry answers with an
**address** and steps out of the way — it never relays your traffic.

Pull the router's own manifest into an index, then `find` the capability and read the address off
the match:

```ts
import { createRegistry, registerProviderRouter } from '@agora/registry';

const registry = createRegistry();
await registerProviderRouter(registry, 'http://127.0.0.1:8000');   // crawls the router's published manifest

const [match] = registry.find({ capability: 'generate.text' });    // ranked cheapest-first
// match.address is the whole point — dial it directly (it is the http://…/v1 base from Step 1).
console.log(match.identity, match.address, match.estUnits, match.unpriced);
```

`find` ranks zero-cost routes first and *unpriced* ones last — unknown cost is not treated as
free. The registry can also **chain** capabilities across several providers and hand back the plan
plus its projected cost, so a caller can check its budget before spending anything:

```ts
const plan = registry.path({ from: { plane: 'knowledge' }, to: { plane: 'media' } });
console.log(plan?.steps.map((s) => s.capability), plan?.projectedUnits);
```

Your *own* project joins the same way. Serve a KCB manifest describing what it offers, then index
it with `registerFromWellKnown(registry, 'https://your-peer.example')`. Discovery returns its
address; callers dial it directly. Details in [`../registry/README.md`](../registry/README.md).

### From outside this repo

`@agora/registry` is a workspace package — it is not published, so a project that installed only
`@agora/sdk` reaches a *running* registry over HTTP instead. The same three moves, from the client
side:

```ts
import { createDiscoveryClient, openAiConfigFor } from '@agora/sdk';

const discovery = createDiscoveryClient('http://127.0.0.1:8787');   // npm start -w @agora/registry
await discovery.publish(myManifest);                                 // push: for a peer nothing can crawl

const [gateway] = await discovery.find({ capability: 'generate.text' });
const config = openAiConfigFor(gateway.manifest, { capability: 'generate.text', budgetUnits: 0 });
// → { baseUrl: 'http://127.0.0.1:8000/v1', headers: { 'X-Agora-Budget-Units': '0' }, … }
```

`config` is what you construct your OpenAI client with — the Python snippet from Step 1, with the
base URL and the ceiling header *discovered* rather than hard-coded. The SDK builds the
configuration and stops there; the call is yours, and it goes straight to the router.
`examples/participant-starter/src/onboarding.test.ts` drives this whole path end to end.

## Step 3 — Prove it end to end with a conformance scenario

The final move is proof. The **conformance console** runs a scenario against the *real*
connections between services and asserts that the invariants held — it observes the actual wire,
it is not a hub sitting in the middle. Bring up the UI (it discovers the router at
`127.0.0.1:8000`) and run the round-trip that ships with it:

```sh
npm run dev -w @agora/console
# In the UI, run `kcs:provider-router-roundtrip`: discover the router through the registry,
# dial its address under a zero-unit budget ceiling, and assert the zero-spend tier served the
# request for nothing.
```

There is no separate scenario CLI binary. To run one in code, import `runConformance`
(`console/src/commons.ts`) and `findScenario` (`console/src/scenarios/library.ts`).
`runConformance` crawls the router into a registry, runs the scenario, and returns a
content-addressed report you can cite and archive:

```ts
import { runConformance } from '../console/src/commons';
import { findScenario } from '../console/src/scenarios/library';

const run = await runConformance(findScenario('kcs:provider-router-roundtrip')!);
console.log(run.report.address, run.report.verdict);   // a citable sha256-… report
```

The two scenarios that ship (`kcs:provider-router-roundtrip` and `kcs:sample-pipeline`) are
**illustrative, not normative** — they demonstrate the machinery. You write your own scenarios
against your own services, naming each participant by its identity. Details in
[`../console/README.md`](../console/README.md).

## That's the whole loop

**Run → discover → prove.** You started a gateway that never fails and never surprises you with a
bill, found it by what it does rather than where it lives, and proved the round-trip against the
real connection. Everything else agora offers — the identity resolver, the translation engine, the
fine-tuning provider — plugs into the same three moves.

To understand *why* it is built this way — the always-completes supervision tree, the polyglot
stack, the registry and resolver design — read [`../DESIGN.md`](../DESIGN.md).
