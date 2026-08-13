# Thin local-inference examples

A small cast of **sample** participants — one app and three services, each barely more than a
wrapper around a local inference call — so there is something real running to look at: a fabric
you can crawl, dial and watch without wiring your own first.

Each one is the same three ideas as [`../participant-starter/`](../participant-starter/), which is
the file to copy when you build your own: a KINP identity, one capability, and a function that
answers. The difference is only that these are a *cast* rather than a single peer, and that
[`src/wire.ts`](src/wire.ts) — the A2A/MCP plumbing a real deployment takes from a server library —
is written once and shared between them.

Nothing here downloads a model or spends anything: the "inference" is a deterministic local
function, standing in for the llama.cpp / MLX / Ollama call you would put in its place.

## The cast

| Peer | Capability | Transport | What the local call does |
|---|---|---|---|
| `example:agent:notes-app` | `notes.compose` | A2A | Turns a transcript into bulleted notes |
| `example:agent:keywords` | `extract.keywords` | A2A | Ranks the terms a text is about |
| `example:agent:sentiment` | `classify.sentiment` | MCP | Calls a text positive / negative / neutral |
| `example:agent:embeddings` | `embed.text` | A2A + MCP | Hashes a text into a unit vector |

Every identity above is **sample data** — made-up peers, `example:` scoped on purpose. agora ships
no roster (`../../CLAUDE.md`: capability, never caller); this is a demonstration cast, and the
topology configs that arrange it are sample data too.

## Run one

```sh
node src/notes.ts                                        # PORT=8791 by default
curl localhost:8791/.well-known/agent-card.json          # its card, KCB manifest inside
curl localhost:8791/.well-known/kcb-manifest.json        # the same manifest, bare (KCB §3)
curl -X POST localhost:8791/a2a -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user",
       "parts":[{"kind":"text","text":"We shipped the gate. Ana owns the rollout."}]}}}'
```

The MCP peers answer at `/mcp`, serving one tool named after their capability — `initialize`,
`tools/list`, `tools/call`, which is exactly what the conformance console's `mcp` wire dials:

```sh
node src/sentiment.ts                                    # PORT=8793 by default
curl -X POST localhost:8793/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"classify.sentiment","arguments":{"text":"the gate is green and fast"}}}'
```

Each file runs as written — no build step, no loader flag — because the source stays inside what
Node's strip-only TypeScript loader accepts. A test spawns `node src/notes.ts` and fetches its
manifest, so that stays true.

## The routes

| Route | What it is |
|---|---|
| `GET /.well-known/kcb-manifest.json` | The KCB capability manifest, bare — what a registry crawl pulls (§3). Always served. |
| `GET /.well-known/agent-card.json` | The A2A AgentCard carrying that manifest as its one extension (§2/§6). Served by the A2A peers. |
| `POST /a2a` | One A2A `message/send` → one completed Task. |
| `POST /mcp` | The MCP handshake and one tool call (§4). Served by the MCP peers. |

A peer publishes the endpoints it actually answers on and only those, so the manifest is a true
statement about the process — an MCP-only peer serves no agent card, and says so with a 404.

## The example setups

Three sample topologies arrange the cast into fabrics you can load into
[Agora Studio](../../studio/) as-is, so a first look at Studio is a populated one:

| Setup | What it shows |
|---|---|
| `notes-desk` | one app and the two services it dials — one over A2A, one over MCP |
| `embedding-pipeline` | a chain across both transports, ending in a shape that is not prose |
| `whole-cast` | every example at once, plus a peer nothing here runs — named, with no address |

Start one and it prints the config for the ports it actually bound:

```sh
node src/topologies.ts                                   # the setups, listed
node src/topologies.ts notes-desk                        # start that cast, print its config
node src/topologies.ts notes-desk --print > my-fabric.json   # just the config, default ports
```

The checked-in [`configs/*.studio.json`](configs/) are that same document for the ports each peer
binds by default, which is what `node src/notes.ts` and friends do — so
`node src/topologies.ts whole-cast` and `configs/whole-cast.studio.json` describe the same
running fabric. Paste one into the `<script type="application/json" id="studio-config">` block of
the page that serves Studio and the graph, the connection panel and the spec viewer are populated
by it.

Each config carries, per participant, where it publishes (`endpoints`) and the documents it
serves (`manifest`, and `card` for the A2A peers) — read off the running processes, so Studio has
a real address to observe each link at and the participants' own words to render. `topologies.ts`
generates them and `topologies.test.ts` fails if a file drifts from what it generates or from what
the processes actually serve; regenerate with the `--print` line above.

These are **sample data**, and each file says so in its own `note`: agora ships no roster
(`../../CLAUDE.md`), Studio starts empty, and this is a demonstration you load — never a default.

## Where it depends

On the **published** [`@agora/sdk`](../../clients/sdk/) and nothing else in this repo (the tests
also use `@agora/schemas`, the SDK's own one dependency, as an independent judge of the manifests).
The dependency points one way: examples consume the SDK, the SDK never consumes an example. That
is what makes this directory proof the published surface is sufficient — if serving a manifest
needed something the SDK does not export, these files could not exist.

The gate is `make check-examples`.
