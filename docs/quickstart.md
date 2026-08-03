# Quickstart: install to first call

From nothing to a peer that other systems can find and dial — in three steps and about five
minutes. You will install the client SDK, run the ~20-line participant starter so it serves an
**AgentCard** carrying a **KCB capability manifest**, and then make the first call against it from
your own code.

Every command and every output below is real and copy-pasteable; nothing here is a placeholder.

> **What you need.** Node 22 or newer (`node --version`) and `git`. Nothing else — no keys, no
> account, no server to sign up for.

> **Two terms.** A **capability** is something a service can do, described by what it consumes and
> produces ("text in → text out"). A **KCB manifest** is the small document a service publishes to
> advertise its capabilities so others can find it. You do not need to have read any specification
> to follow along.

## Addresses, not a relay — read this first

The SDK hands you an **address**. You dial it yourself.

There is no bus to join, no hub to route through, and no `invoke` / `call` / `send` on the SDK —
there never will be. `describeSdk().relaysPayloads` is `false`, and the SDK's own test suite fails
the build if a relay-shaped name ever appears on its surface. Discovery is the shared part; the
connection is yours, end to end, and your traffic never passes through the commons
([ADR-0001](https://github.com/danieldekerlegand/koine/blob/main/decisions/ADR-0001-control-plane-topology.md)
decisions 2–4).

So the shape of every interaction in this guide is: **read a card → get an address → dial it
directly**.

## Step 1 — Install the SDK

`@agora/sdk` is the single package a participant installs. It brings exactly one dependency
(`@agora/schemas`) and nothing else.

Clone the repo and install the workspace:

```sh
git clone https://github.com/danieldekerlegand/agora.git
cd agora
npm install
```

To use the SDK from **your own project**, build the publishable packages and pack them:

```sh
make build-sdk                                        # emits dist/ and stages the publishable packages
npm pack ./schemas/.publish ./clients/sdk/.publish     # → agora-schemas-0.1.0.tgz, agora-sdk-0.1.0.tgz
```

Then, in your project:

```sh
npm install /path/to/agora/agora-schemas-0.1.0.tgz /path/to/agora/agora-sdk-0.1.0.tgz
```

That is the whole install. The two tarballs are exactly what `npm publish` would ship — once
`@agora/sdk` is on a public registry the same install is one line, `npm install @agora/sdk`, and
nothing else in this guide changes. (Working *inside* the clone, you need none of this: the
workspace already links the SDK, so `npm install` at the root is enough.)

## Step 2 — Run the participant starter

The starter is the smallest thing that is a discoverable, dial-able peer. From the clone:

```sh
node examples/participant-starter/src/participant.ts       # PORT=8790 by default
# example:agent:summarizer listening on http://127.0.0.1:8790 — card at http://127.0.0.1:8790/.well-known/agent-card.json
```

In a second terminal, fetch its **AgentCard** — the document that makes it findable:

```sh
curl localhost:8790/.well-known/agent-card.json
```

```jsonc
// pretty-printed here for reading; the server answers on one line
{
  "name": "example:agent:summarizer",
  "url": "http://localhost:8790",
  "capabilities": {
    "extensions": [
      {
        "uri": "https://koine.dev/kcb/manifest/0.3",
        "description": "Koine capability-bus manifest",
        "required": false,
        "params": {                                   // ← the KCB manifest rides here
          "kcb_version": "0.2.0",
          "identity": "example:agent:summarizer",
          "endpoints": {
            "a2a": "http://localhost:8790/.well-known/agent-card.json",
            "manifest": "http://localhost:8790/.well-known/kcb-manifest.json"
          },
          "capabilities": [
            {
              "name": "summarize.text",
              "inputs": [{ "plane": "knowledge", "shape": "text" }],
              "outputs": [{ "plane": "knowledge", "shape": "text" }],
              "cost": { "est_units": 0 }
            }
          ]
        }
      }
    ]
  }
}
```

That is the entire contract of being a participant: an A2A AgentCard whose single extension is
your KCB manifest — who you are, where to dial you, and what you consume and produce. The starter
also serves the same manifest as a bare body at `/.well-known/kcb-manifest.json`, which is what a
registry crawl pulls.

You can answer it straight away over the wire:

```sh
curl -X POST localhost:8790/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"A commons is a shared runtime. Everything else is detail."}]}}}'
```

```jsonc
{"jsonrpc":"2.0","id":1,"result":{"id":"…","status":{"state":"completed","message":{"role":"agent",
  "parts":[{"kind":"text","text":"A commons is a shared runtime."}],"messageId":"…"}}}}
```

## Step 3 — Your first call, through the SDK

Now do it the way a real peer does: read the card, project it onto an address, and dial that
address yourself. Save this as `call-a-peer.mjs` in the project where you installed the SDK:

```js
import { addressOf, endpointFor, isDialable, parseManifest, transportOf } from '@agora/sdk';

const base = process.argv[2] ?? 'http://localhost:8790';

// 1. Fetch the peer's AgentCard and read its KCB manifest back off it.
const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
const manifest = parseManifest(card);

// 2. Project it onto an ADDRESS. The SDK stops here — it never dials for you.
const address = addressOf(manifest);
const capability = manifest.capabilities.find((c) => c.name === 'summarize.text');
console.log(isDialable(address), transportOf(address, capability), endpointFor(address, capability));

// 3. You dial it yourself, directly, over the transport the address named.
const reply = await (await fetch(card.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text: 'A commons is a shared runtime. Everything else is detail.' }] } },
  }),
})).json();
console.log(reply.result.status.message.parts[0].text);
```

```sh
node call-a-peer.mjs
# true a2a http://localhost:8790/.well-known/agent-card.json
# A commons is a shared runtime.
```

That is a first successful call. Note what step 2 did *not* do: it returned a URL and a transport
name and then got out of the way. `transportOf` names a protocol; it never opens one.

## Make it yours

Copy [`examples/participant-starter/src/participant.ts`](../examples/participant-starter/src/participant.ts)
into your own project and change three things above its `copy from here` divider:

- `IDENTITY` — your [KINP](https://github.com/danieldekerlegand/koine/blob/main/specs/identity.md)
  id instead of `example:agent:summarizer`.
- `CAPABILITY` — what you actually offer instead of `summarize.text`, and the `inputs`/`outputs`
  planes that describe it.
- `summarize()` — your real work.

Everything below the divider is A2A/JSON handling a real deployment would take from an A2A server
library; it is spelled out so the starter depends on nothing beyond `@agora/sdk` and Node.

Publishing the card is what makes you findable. A registry crawls it, indexes what you said you can
do, and hands your **address** to callers — it never relays their traffic:

```ts
import { createRegistry, registerFromWellKnown } from '@agora/registry';

const registry = createRegistry();
await registerFromWellKnown(registry, 'http://127.0.0.1:8790');
const [match] = registry.find({ capability: 'summarize.text' });   // match.address is yours
```

## Going deeper

- [**Wiring a project into agora**](walkthrough-wiring-a-project.md) — the same fabric from the
  other direction: run the zero-spend model gateway, discover a capability through the registry,
  and prove the round-trip with a conformance scenario.
- [**The participant starter**](../examples/participant-starter/README.md) — the starter's routes,
  line by line.
- [**`@agora/sdk` reference**](../clients/sdk/README.md) — the full public API: `SDK_API.discover`,
  `SDK_API.participate`, `SDK_API.knowledge`.
- [**How agora relates to existing tools**](prior-art.md) — what is deliberately reused (A2A agent
  cards, MCP, the OpenAI API) and what agora adds.
- [**koine**](https://github.com/danieldekerlegand/koine) — the specifications this implements.
  [Capability-Bus](https://github.com/danieldekerlegand/koine/blob/main/specs/capability-bus.md)
  (KCB) is the one behind everything above.
