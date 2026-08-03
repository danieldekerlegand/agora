# The participant starter

The smallest thing that is a **discoverable, dial-able peer**: about twenty lines that publish an
A2A AgentCard carrying a KCB capability manifest, and answer one request on the wire.

Copy [`src/participant.ts`](src/participant.ts), change the identity and the capability, replace
`summarize` with your real work. That is the whole onboarding. There is no bus to register with
and no hub to route through — a peer reads your card, learns **where** to dial you and **what** you
can do, and dials you *directly* (ADR-0001 decisions 2–4; the SDK hands back an address and steps
out of the way).

## Run it

```sh
npm install @agora/sdk
node src/participant.ts                                # PORT=8790 by default

curl localhost:8790/.well-known/agent-card.json        # your card, KCB manifest inside
curl -X POST localhost:8790/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user",
       "parts":[{"kind":"text","text":"A commons is a shared runtime. Everything else is detail."}]}}}'
# → {"jsonrpc":"2.0","id":1,"result":{"status":{"state":"completed","message":{"parts":[
#      {"kind":"text","text":"A commons is a shared runtime."}]}}}}
```

In this repo the workspace already links the SDK, so `npm install` at the root is enough and the
gate is `make check-examples`.

## The routes

| Route | What it is |
|---|---|
| `GET /.well-known/agent-card.json` | Your A2A AgentCard. Its single KCB extension (`params`) is your capability manifest: your KINP identity, your endpoints, and what you produce and consume, plane-typed. |
| `GET /.well-known/kcb-manifest.json` | The same manifest as a bare body, which is what a registry crawl pulls (KCB §3). |
| `POST /` (the `url` your card names) | One A2A `message/send`. You return a completed Task carrying the answer. |

Everything above the divider in `participant.ts` is yours to change; below it is A2A/JSON handling
a real deployment would take from an A2A server library, spelled out so the starter depends on
nothing but `@agora/sdk` and Node.

## Being found

Publishing the card is what makes you findable — a registry crawls it, indexes what it says you can
do, and hands your address to callers:

```ts
import { createRegistry, registerFromWellKnown } from '@agora/registry';

const registry = createRegistry();
await registerFromWellKnown(registry, 'http://127.0.0.1:8790');
const [match] = registry.find({ capability: 'summarize.text' });   // match.address is yours
```

The identity (`example:agent:summarizer`) and the capability (`summarize.text`) here are sample
data — a made-up peer. Describe what *you* actually do.

## Going deeper

- [`docs/walkthrough-wiring-a-project.md`](../../docs/walkthrough-wiring-a-project.md) — the other
  direction: running the gateway, discovering a capability, proving a round-trip.
- [`clients/sdk/README.md`](../../clients/sdk/README.md) — the SDK's full surface.
