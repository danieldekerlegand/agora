# `resolver` — the KINP resolver

The reference implementation of **KINP §8** (`koine/specs/identity.md`): the two identity
verbs — `resolve` and `reconcile` — against a deployment's **resolution authority**, the single
canonical store for real-world entities (§11 decision 1). Which store that is, is *configuration*:
an address the registry handed back, never a hard dependency compiled in here.

A leaf capability per ADR-0001 decision 3 — a lookup service that returns **identity, not
payloads**. It computes the merged view, it does not own it.

## What it does

- **`resolve(ref)`** computes the §8 merged view (`{ entity, same_as_closure[], based_on[],
  provenance[], attached_assets[] }`) rather than storing it (§4.1). The walk follows `same_as`
  transitively and bidirectionally but **never crosses a `based_on` edge** — that one rule is the
  identity firewall (§4.3), and `sameAs` / `basedOn` are kept as separate fields so it cannot be
  smuggled around. A fictional entity that is `same_as` a locally-extracted entity and `based_on`
  a real-world one resolves to the local entity and stops.
- **`reconcile(query)`** takes the OpenRefine/Wikidata Reconciliation query verbatim (§4.5),
  ranks candidates, then decides **which** relation to apply (worlds that inherit identity ⇒
  `same_as`, worlds that do not ⇒ `based_on`) and **whether** to apply it: auto-apply above a
  per-world confidence threshold, and queue anything below-threshold, ambiguous, or high-impact.
  Queued proposals land on `resolver.reviewQueue` and **nothing there has been asserted** —
  equivalence is the authority's to assert, not the resolver's to guess.

Authority is a **role, not a hard dependency**: content-hash ids resolve without dialing anyone
(§6), an unknown well-formed id resolves to itself, and a failed dial falls back to the local
cache — labelled `authority: 'cache'`, never as the authority itself.

## Build & test

Standalone within the npm workspace (single dependency: `@agora/schemas`).

```sh
make check-resolver            # from repo root: lint + typecheck + vitest for @agora/resolver
# or, inside resolver/:
npm run typecheck              # tsc -p tsconfig.json
npm run test                   # vitest run
npm run start                  # node src/main.ts — boot the HTTP service
```

## Public API

Everything is re-exported from `src/index.ts`.

**Constructors** (each returns a `Resolver` — `{ resolve, reconcile }`):

- `createLocalResolver(): Resolver` — offline/degraded: recognises well-formed KINP ids and
  resolves each to itself; `reconcile` always rejects (equivalence is the authority's to assert).
- `createAuthorityResolver(options: AuthorityOptions): AuthorityResolver` — dials the authority.
  `resolve` only issues an HTTP request for `ent`-kind ids; everything else resolves locally.
  `reconcile` returns ranked candidates plus a `LinkProposal`. Adds `reviewQueue` / `applied`
  (both `readonly LinkProposal[]`).
- `createResolverServer(options?): ResolverService` — the HTTP surface (`GET /`, `GET /describe`,
  `GET|POST /resolve`, `POST /reconcile`). `ResolverUnavailableError` → 400,
  `AuthorityUnreachableError` → 502, unknown path → 404.
- `startResolver(env?): Promise<StartedResolver>` — reads the environment (below) and listens.
- `describeResolver(): ResolverDescription` — `{ identity: 'agora:agent:resolver', kinpVersion,
  implemented: true, verbs: ['resolve', 'reconcile'] }`; `kinpVersion` is pinned to
  `SPEC_VERSIONS.kinp` in `@agora/schemas`.

**Policy & storage seams** — `mergePolicy(overrides?)` / `DEFAULT_MERGE_POLICY` (per-world
threshold `0.9`, ambiguity margin `0.05`), the in-memory / file caches
(`createMemoryCache`, `createFileCache`) and link stores (`createMemoryLinkStore`,
`createFileLinkStore`). The file cache re-runs the `same_as`/`based_on` closure at read time, so
the firewall is a property of *reading* the store, not just of writing it.

### Environment (the standalone service)

```
AGORA_RESOLVER_HOST        bind host        (default 127.0.0.1)
AGORA_RESOLVER_PORT        bind port        (default 8788)
AGORA_RESOLVER_AUTHORITY   authority base URL (the address the registry handed back)
AGORA_RESOLVER_IDENTITY    the authority's KINP identity
AGORA_RESOLVER_CACHE       path for the fallback cache store
AGORA_RESOLVER_LINKS       path for the applied/review link store
```

## Usage

In-process, resolving against a configured authority:

```ts
import { createAuthorityResolver } from '@agora/resolver';

const resolver = createAuthorityResolver({
  endpoint: 'https://authority.example',   // an address the registry returned
  identity: 'refkb:agent:authority',
});

const merged = await resolver.resolve({ id: 'refkb:ent:napoleon' });
// merged.sameAs / merged.basedOn are the firewall-preserving closure

const result = await resolver.reconcile({
  query: 'Napoleon Bonaparte',
  world: 'refkb:world:consensus-reality',
  of: 'refkb:ent:local-napoleon',
});
// result.proposal.relation is 'same_as' | 'based_on' | null;
// below-threshold / ambiguous / high-impact proposals wait — asserted by nobody:
resolver.reviewQueue;   // readonly LinkProposal[]
resolver.applied;       // readonly LinkProposal[]
```

Standalone over HTTP:

```sh
AGORA_RESOLVER_AUTHORITY=https://authority.example npm run start
# GET  /resolve?id=refkb:ent:napoleon
# POST /reconcile  {"query":"Napoleon Bonaparte","of":"refkb:ent:local-napoleon"}
```
