# `registry` — the KCB discovery registry

The reference **KCB discovery registry** (`koine/specs/capability-bus.md` §3): a thin
cache/index over KCB capability manifests that answers a lookup with **addresses**, never with
traffic. Route-by-lookup, not route-by-proxy — ADR-0001 decision 3. `describeRegistry()` states
the promise structurally: `proxiesTraffic: false`. A caller `find`s a provider here and then
dials the returned address itself; `invoke` is never the registry's job.

Three invariants hold everywhere in the code: **never proxy** (returns addresses), **the
provider's manifest is authoritative** (§3), and **zero-cost routes rank first** with *unpriced*
(unknown-cost) routes last — unknown is not free (§3 delta K).

## Build & test

Depends on `@agora/sdk` and `@agora/schemas` within the npm workspace; a Rust crate
(`path-index/`) is the optional native engine behind `path()`.

```sh
make check-registry            # from repo root: the TS gate + the Rust path-index crate
# or, inside registry/:
npm run typecheck              # tsc -p tsconfig.json
npm run test                   # vitest run
npm run start                  # node src/main.ts — boot the HTTP service
npm run build:native           # build the optional Rust N-API addon
```

`make check-registry` also runs `cargo test` + `cargo clippy` in `path-index/` **when cargo is
present**; a Rust-less host still passes, because `CapabilityRegistry.path()` falls back to a
pure-TypeScript search whose output is pinned byte-for-byte against the native crate.

## Public API

Re-exported from `src/index.ts`.

**The registry itself** — `createRegistry(): CapabilityRegistry` (in-memory) /
`createDurableRegistry(store): CapabilityRegistry` (backed by a `ManifestStore` —
`createMemoryStore` / `createFileStore`). `CapabilityRegistry` methods:

- `register(manifest, options?)` / `remove(identity)` / `get(identity)` / `list()` — the index.
- `address(identity): ProviderAddress | undefined` — the whole point: what a caller dials.
- `find(query: FindQuery): Match[]` — providers matching a `capability` / `plane` / `world` /
  input-output `port`, **ranked cheapest-first** (`compareByCost`); each `Match` carries the
  `address`, its matched capabilities, `estUnits` and an `unpriced` flag.
- `path(query: PathQuery): CapabilityPath | undefined` — chains capabilities across providers
  (KCB §3 composition, default `maxHops: 4`); returns the ordered `steps` plus `projectedUnits`,
  so a caller can gate spend before invoking anything.
- `selectFinetune(job): ProviderSelection` — disambiguates multiple `finetune` providers (prefer
  the more **specialized**, then cheaper; a genuine tie is surfaced, never broken by order).

**Pull-population** (`crawl.ts`) — fetch a peer's well-known manifest and index it:
`registerFromWellKnown(registry, baseUrl)`, plus the two named convenience crawlers
`registerProviderRouter(registry, baseUrl?)` and `registerTrainer(registry, baseUrl?)`. Constants:
`KCB_MANIFEST_PATH = '/.well-known/kcb-manifest.json'`, `PROVIDER_ROUTER_BASE_URL =
'http://127.0.0.1:8000'`, `TRAINER_BASE_URL = 'http://127.0.0.1:8001'`, and their identities.

**Standalone service** — `createRegistryServer(options?)` (routes: `POST /register`, `/crawl`,
`/remove`; `GET /list`, `/get`, `/address`, `/find`, `POST /find`, `POST /path`), and
`startRegistry(env?)` / `registryLaunchFromEnv(env?)`. **Cross-registry replication** lives in
`replication.ts` (`createReplicator`).

`describeRegistry()` reports `identity: 'agora:agent:registry'`, `kcbVersion` (pinned to
`SPEC_VERSIONS.kcb`), `proxiesTraffic: false`, and the verb list
`['register','remove','get','list','address','find','path','selectFinetune']`.

### Environment (the standalone service)

```
AGORA_REGISTRY_HOST    bind host                  (default 127.0.0.1)
AGORA_REGISTRY_PORT    bind port                  (default 8787)
AGORA_REGISTRY_STORE   path for a durable store   (in-memory if unset)
AGORA_REGISTRY_PEERS   comma-separated peer registries to replicate with
```

## Usage

```ts
import { createRegistry, registerProviderRouter, type Match } from '@agora/registry';

const registry = createRegistry();                    // route-by-lookup, never proxies
await registerProviderRouter(registry);               // pull the router's well-known manifest (:8000)

const matches: Match[] = registry.find({ capability: 'generate.text' });
for (const m of matches) {
  // m.address is what you dial — directly, over its own transport. Nothing flows through here.
  console.log(m.identity, m.address, m.estUnits, m.unpriced);
}

// Plan a route across planes/providers and read its projected cost before spending.
const plan = registry.path({ from: { plane: 'knowledge' }, to: { plane: 'media' } });
plan?.steps.forEach((s) => console.log(s.identity, s.capability, s.endpoint, s.estUnits));
```

## The `path-index/` crate

`path-index/` is `agora-path-index`, a Rust crate (`rlib` + `cdylib`) — a faithful port of
`src/path.ts` + `ports.ts` + `cost.ts`, loaded **in-process** via an N-API addon
(`src/path-index.ts`), never as a service. It returns a plan of addresses + capability names,
never a payload (ADR-0001 decision 3). It is **native-optional**: absent the addon, the TS shim
uses the pure-TS `findCapabilityPath`, and `src/fixtures/golden-paths.json` pins the two paths to
identical output.
