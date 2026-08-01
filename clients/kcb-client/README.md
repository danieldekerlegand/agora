# `@agora/kcb-client` — the KCB control-plane client

The client library for the **KCB control plane** (`koine/specs/capability-bus.md` §2): registry
lookup and **direct-dial addressing**. It owns the *address shape* — the one projection that turns
a KCB `CapabilityManifest` into the endpoint a caller dials, and the rule for which transport that
endpoint speaks.

By ADR-0001 (decisions 2–4) it is deliberately **pure and synchronous**: it does no network I/O,
holds no HTTP client, and **never fetches or dials**. It only ever *returns endpoints* — the
module doc forbids it ever growing a "call it for me" method that relays a payload, because that
is exactly the traffic hub the topology exists to avoid. The lookup verbs live in
`@agora/registry`; this package is the address projection underneath them.

## Build & test

Only dependency: `@agora/schemas`.

```sh
make check-clients             # from repo root: gates BOTH client packages (lint + typecheck + vitest)
# or, inside clients/kcb-client/:
npm run typecheck              # tsc -p tsconfig.json
npm run test                   # vitest run
```

## Public API

Exported from `src/index.ts`:

- `addressOf(manifest: CapabilityManifest): ProviderAddress` — the **only** projection this client
  makes: a manifest's identity plus its published endpoints.
- `isDialable(address: ProviderAddress): boolean` — true when the address carries any endpoint.
- `endpointFor(address, capability?): string | undefined` — the URL to dial: a capability's own
  `endpoint` if it declares one, else the address's `mcp`, else its `a2a` endpoint.
- `transportOf(address, capability?): Transport | undefined` — names the transport
  `endpointFor` resolves over, precedence `openai` → `mcp` → `a2a`.
- Types: `ProviderAddress { identity; endpoints }`, `ProviderEndpoints { mcp?; a2a?; [name] }`,
  `Transport = 'mcp' | 'a2a' | 'openai'`.
- `KCB_CLIENT_VERSION` — pinned to `SPEC_VERSIONS.kcb` (`0.2.0`).

## Usage

```ts
import { addressOf, endpointFor, transportOf, isDialable } from '@agora/kcb-client';
import type { CapabilityManifest } from '@agora/schemas';

// The manifest is obtained elsewhere — e.g. a @agora/registry lookup, or a peer's
// /.well-known/kcb-manifest.json fetched by the caller. This library does no I/O.
const address = addressOf(manifest);

if (isDialable(address)) {
  const cap = manifest.capabilities?.[0];      // e.g. { name: 'generate.text', endpoint: '…/v1/chat/completions' }
  const url = endpointFor(address, cap);       // → the URL to dial
  const wire = transportOf(address, cap);      // → 'openai' | 'mcp' | 'a2a'
  // The caller opens `wire` against `url` itself. Nothing flows through the commons.
}
```
