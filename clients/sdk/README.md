# `@agora/sdk` — the client SDK for a KCB participant

One install, one import: everything a peer needs to **become discoverable** (serve an AgentCard
carrying a KCB manifest extension) and to **find another peer** (turn a manifest into the address
it dials directly).

```sh
npm install @agora/sdk
```

That is the whole dependency list — `@agora/schemas` comes with it, and nothing else does. Until
that package is on a public registry, `make build-sdk` + `npm pack` produces the identical
tarballs to install from a path; [`docs/quickstart.md`](../../docs/quickstart.md) walks that
through to a first call.

## Addresses, never a relay

By ADR-0001 (decisions 2–4) the KCB control plane hands back **addresses**; the caller opens the
connection itself, directly, over A2A/MCP/OpenAI. So this SDK is pure and synchronous but for two
members that talk to the **control plane** and nothing else — `loadRelationRegistry` (koine's
registry data) and `createDiscoveryClient` (your manifest out, addresses back). Neither carries a
peer's payload: it does not dial a provider, and it has no `invoke` / `call` / `send`. It never will —
`describeSdk().relaysPayloads` is `false` and `src/index.test.ts` fails the build if a relay-shaped
name ever appears on the surface. An SDK that dialed on your behalf would make the commons the
traffic hub the topology exists to avoid.

## Public API

Everything below is exported from the package root (`@agora/sdk`) and enumerated at runtime as
`SDK_API`, grouped the way it is used. Deep paths (`@agora/sdk/src/…`) are not part of the promise.

### `SDK_API.discover` — where a peer is

- `addressOf(manifest: CapabilityManifest): ProviderAddress` — the one projection: a manifest's
  identity plus its published endpoints.
- `isDialable(address): boolean` — true when the address carries any endpoint.
- `endpointFor(address, capability?): string | undefined` — the URL to dial: a capability's own
  `endpoint` if it declares one, else the address's `mcp`, else its `a2a`. `undefined` rather than
  a guess when the provider published nothing.
- `transportOf(address, capability?): Transport | undefined` — names the transport `endpointFor`
  resolves over, precedence `openai` → `mcp` → `a2a`. It names a protocol; it never opens one.
- `KCB_CLIENT_VERSION` — the KCB version this build speaks, pinned to `SPEC_VERSIONS.kcb`.
- Types: `ProviderAddress { identity; endpoints }`, `ProviderEndpoints { mcp?; a2a?; [name] }`,
  `Transport = 'mcp' | 'a2a' | 'openai'`.

A registry is reached over HTTP, because its in-process API is a workspace package no consumer
installs:

- `createDiscoveryClient(registryUrl, options?): DiscoveryClient` — `publish(manifest)` (the §3
  push path, for a producer a registry cannot crawl), `find(query?)`, `address(identity)`,
  `withdraw(identity)`, `describe()`. Uses `globalThis.fetch` unless you pass `options.fetch`.
- `DISCOVERY_ROUTES` — every route the client will ever dial, by verb. All five are lookups; a
  registry has no route that relays a payload, and `describe().proxiesTraffic` is how you check
  a strange one before publishing to it.
- `DiscoveryError` (carries `url` and, when the registry answered, `status`). A malformed manifest
  throws `ManifestError` instead — `publish` parses locally, so that failure happens in your
  process rather than as a 400 from a stranger.
- A match's `address` is projected here from the manifest the registry returned, not copied from
  the index: KCB §3 makes the provider's own document authoritative and the index a cache.
- Types: `DiscoveryClient`, `DiscoveryQuery { capability?; plane?; world? }`, `DiscoveredProvider`,
  `DiscoveredCapability`, `PublishedRegistration`, `RegistryDescription`, `DiscoveryFetch`,
  `DiscoveryOptions`.

### `SDK_API.gateway` — pointing your own OpenAI client at a discovered gateway

- `openAiConfigFor(manifest, options?): OpenAiClientConfig | undefined` — the `baseUrl`, `headers`
  and `model` you construct an OpenAI client with, read off the provider's manifest. `undefined`
  rather than a guess when the provider publishes no `openai` endpoint, does not publish the named
  capability, or serves it somewhere that base URL does not host.
- `BUDGET_UNITS_HEADER` — the default spend-ceiling header (`X-Agora-Budget-Units`). A provider
  that publishes `auth.budget_units.header` names its own and that one wins; ask for a ceiling of a
  provider that declares none and `honorsBudgetUnits` is `false` and **no header is invented** —
  you learn the ceiling will not be honored before you spend, not after (KCB §5).
- Types: `OpenAiClientConfig { baseUrl; headers; model?; honorsBudgetUnits; budgetUnitsKey? }`,
  `OpenAiConfigOptions { capability?; budgetUnits? }`.

It builds the configuration; the call stays yours — nothing here opens a connection or carries a
prompt.

### `SDK_API.participate` — the document that makes you findable

The KCB manifest rides as one **extension of your A2A AgentCard** (KCB §2), not as a second
well-known document.

- `embedManifest(card, manifest): AgentCard` — attach the manifest to a card as the
  `KCB_MANIFEST_EXTENSION_URI` extension. This is what you serve at
  `/.well-known/agent-card.json`.
- `toAgentCardExtension(manifest): AgentExtension` — the extension entry alone.
- `parseManifest(card): CapabilityManifest` — read the KCB manifest back off a fetched card
  (throws `ManifestError`); `parseManifestBody(value)` for a bare payload,
  `isCapabilityManifest(value)` for a non-throwing check.
- `isCompatibleKcbVersion(version)`, `KCB_MANIFEST_EXTENSION_URI`, `SPEC_VERSIONS`.
- Types: `AgentCard`, `AgentCapabilities`, `AgentExtension`, `CapabilityManifest`, `Capability`,
  `CapabilityCost`, `KnowledgePort` / `MediaPort` / `EntityPort` / `Port`, `ManifestAuth`,
  `ManifestSigning`, `Plane`.

### `SDK_API.knowledge` — the shared relation vocabulary

- `loadRelationRegistry(baseUrl, options?): Promise<LoadedRegistry>` — fetches koine's
  `predicate-mapping.json`, follows it to the vocabulary TSVs it names, validates both, and
  returns the indexed view. Uses `globalThis.fetch` unless you pass `options.fetch`.
- `indexRegistry(snapshot): LoadedRegistry` — the same indexes for a caller that fetched the
  snapshot with its own transport. No I/O.
- `LoadedRegistry`: `relation(name)`, `signature(name)`, `entries(project)`, `egressFor(project)`
  (KGP §7.2 class, most-restrictive wins), `dialectFor(project)` (KGP §5 tier, highest wins).
- `RegistryFetchError` (carries the failing `url`); a validation or version mismatch throws
  `@agora/schemas`'s `RegistryError`. Types `RegistryFetch` / `LoadOptions`.

It **fetches; it never writes and never mirrors** — koine holds the registry data, agora holds the
tooling (ADR-0001). A cached copy is yours, and editing one is how the registry forks.

### Self-describing

- `SDK_VERSION`, `SDK_API`, `describeSdk(): SdkDescription` — the version, the specs it speaks, the
  enumerated surface, and `relaysPayloads: false`.

## Usage

```ts
import {
  addressOf, embedManifest, endpointFor, isDialable, parseManifest, transportOf,
  type CapabilityManifest,
} from '@agora/sdk';

// 1. Be findable: serve this at /.well-known/agent-card.json
const manifest: CapabilityManifest = {
  kcb_version: '0.2.0',
  identity: 'example:agent:sample-provider',
  endpoints: { a2a: 'https://provider.example/a2a' },
  capabilities: [{ name: 'summarize.text' }],
};
const card = embedManifest({ name: manifest.identity, url: manifest.endpoints.a2a }, manifest);

// 2. Find someone: fetch THEIR card yourself, then project it onto an address.
const peer = parseManifest(await (await fetch(`${base}/.well-known/agent-card.json`)).json());
const address = addressOf(peer);
if (isDialable(address)) {
  const capability = peer.capabilities?.[0];
  const url = endpointFor(address, capability);   // → the URL
  const wire = transportOf(address, capability);  // → 'a2a' | 'mcp' | 'openai'
  // You open `wire` against `url`. Nothing flows through the commons.
}
```

```ts
import { createDiscoveryClient, openAiConfigFor } from '@agora/sdk';

// 3. Announce yourself to a registry, then find someone by what they do.
const discovery = createDiscoveryClient('http://127.0.0.1:8787');
await discovery.publish(manifest);                            // you are in the index
const [found] = await discovery.find({ capability: 'generate.text' });

// 4. Point YOUR OpenAI client at the gateway you found. This returns config; you make the call.
const config = openAiConfigFor(found.manifest, { capability: 'generate.text', budgetUnits: 0 });
const client = new OpenAI({ baseURL: config.baseUrl, apiKey: 'unused', defaultHeaders: config.headers });
```

## Build & test

```sh
make check-clients             # from repo root: lint + typecheck + vitest
make build-sdk                 # emit dist/ (JS + .d.ts) and stage the publishable package
make publish-dry-run           # exactly what `npm publish` would ship
```

In-tree the workspace is **source-first**: `exports` points at `src/index.ts` and nothing is built,
so there is no cross-package build ordering. Publishing is the one exception — `tsconfig.build.json`
emits `dist/`, and `scripts/stage-publish.mjs` assembles `.publish/` (that dist, this README, and a
package.json whose exports point at it). `npm publish ./clients/sdk/.publish` is the ship command;
the source tree is never mutated to publish.

This package consolidates what used to be `@agora/kcb-client` (now `src/kcb.ts`) and
`@agora/relation-registry-client` (now `src/relation-registry.ts`) — two workspace-only source
exports, unusable outside the monorepo, are one installable SDK.
