# `@agora/relation-registry-client` — the relation-registry loader

The read-only loader for the **shared relation registry** — the vocabulary and bridge mappings
that govern KGP knowledge (`koine/specs/grounding-pack.md`). It does one fetch of koine's
`predicate-mapping.json`, follows it to the vocabulary TSVs that document names, validates them
through `@agora/schemas`, and returns an indexed view.

It **fetches; it never writes and never mirrors** — koine holds the data, agora holds the tooling
(ADR-0001). A vendored copy would be the second source of truth the registry exists to prevent.

## Build & test

Only dependency: `@agora/schemas` (which does all the validation).

```sh
make check-clients             # from repo root: gates BOTH client packages (lint + typecheck + vitest)
# or, inside clients/relation-registry-client/:
npm run typecheck              # tsc -p tsconfig.json
npm run test                   # vitest run
```

## Public API

Exported from `src/index.ts`:

- `loadRelationRegistry(baseUrl, options?): Promise<LoadedRegistry>` — fetches
  `${baseUrl}/registry/predicate-mapping.json` (from `RELATION_REGISTRY.mappings`), parses it via
  `parseRegistry`, follows the named vocabulary files, parses them via `parseVocabulary`,
  cross-checks with `assertRelationsResolve`, and returns the indexed registry. Uses
  `globalThis.fetch` unless you pass your own `options.fetch`.
- `indexRegistry(snapshot): LoadedRegistry` — the seam for a caller that already fetched the
  snapshot with its own transport; builds the row/egress/dialect indexes without any I/O.
- `LoadedRegistry` — the indexed view: `relation(name)`, `signature(name)`
  (`relation · arity · arg_roles · symmetric`), `entries(project)`, `egressFor(project)` (KGP
  §7.2 egress class, most-restrictive wins), `dialectFor(project)` (KGP §5 dialect tier, highest
  wins).
- `RegistryFetchError extends Error` (carries the failing `url`); a validation/version mismatch
  throws `@agora/schemas`'s `RegistryError`.
- `RegistryFetch` / `LoadOptions` — the structural `fetch` slice a load needs.

## Usage

```ts
import { loadRelationRegistry } from '@agora/relation-registry-client';
import { filterPackForEgress, assertPackEgress } from '@agora/schemas';

const registry = await loadRelationRegistry('https://koine.example');
// → fetches registry/predicate-mapping.json, then the vocabulary TSVs it names, validates + indexes.

registry.relation('cine:shows')?.arity;                 // 2
registry.signature('soc:parent_of');                    // 'soc:parent_of · 2 · parent|child · false'

const egress = registry.egressFor('some-project');      // (predicate) => 'exportable' | 'local-only'
registry.dialectFor('some-project')('rule_applies');    // e.g. 'full-prolog'

// Close the producer → consumer egress loop (KGP §7.2) with the loaded egress lookup:
const { pack: safe } = filterPackForEgress(pack, egress);   // producer strips local-only
assertPackEgress(safe, egress);                             // consumer verifies (throws on a leak)
```

Pass a custom transport with `loadRelationRegistry(base, { fetch })`, or index an
already-fetched snapshot with `indexRegistry(snapshot)`.
