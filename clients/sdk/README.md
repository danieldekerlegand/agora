# `@agora/sdk` — the client SDK for a KCB participant

One install, one import: everything a peer needs to **become discoverable** (serve an AgentCard
carrying a KCB manifest extension) and to **find another peer** (turn a manifest into the address
it dials directly).

```sh
npm install @agora/sdk
```

That is the whole dependency list — `@agora/schemas` comes with it, and nothing else does.

## Addresses, never a relay

By ADR-0001 (decisions 2–4) the KCB control plane hands back **addresses**; the caller opens the
connection itself, directly, over A2A/MCP/OpenAI. So this SDK is pure and synchronous apart from
`loadRelationRegistry` (which fetches koine's registry data and nothing else): it does not dial, it
does not carry a payload, and it has no `invoke` / `call` / `send`. It never will —
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
  `ManifestSigning`.

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
