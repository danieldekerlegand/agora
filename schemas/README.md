# `schemas` — the shared koine schemas & protocol types

`@agora/schemas` is the one place the koine contracts become **TypeScript**: the manifest
schemas, the interchange-artifact JSON Schemas, the protocol types, and the single pinned set of
spec versions this build implements. Every other TypeScript area (registry, resolver, clients,
console) depends on it, and both provider-router implementations pin their `kcb_version` to the
constant it exports, so the whole tree speaks **one** version of each spec.

It vendors nothing it can help — the relation-registry *data* lives in koine — but it does carry
byte-for-byte snapshots of koine's JSON Schemas and a test fixture, each with a `--check`
regenerator so a drift fails a gate instead of shipping.

## Build & test

Only dependency: `ajv`.

```sh
make check-schemas             # from repo root: lint + typecheck + vitest for @agora/schemas
# or, inside schemas/:
npm run typecheck              # tsc -p tsconfig.json
npm run test                   # vitest run
npm run regen:koine-schemas    # refresh the vendored koine JSON-Schema snapshot from a koine checkout
npm run regen:koine-fixture    # refresh the relation-registry test fixture
# each regen has a :check variant that verifies instead of rewriting (exit 1 on drift)
```

## What it exports

Everything is re-exported from `src/index.ts` **except** the two entry points that are not
environment-free: the validator (`@agora/schemas/validator` — it reads the vendored schemas off
disk, so it is Node-only, and re-exporting it put `node:fs`/`node:path` in the module graph of
every consumer including the console's browser bundle) and the generated test fixture
(`@agora/schemas/fixtures` — test data, not a library surface).

This package is **published** alongside `@agora/sdk`, which is its one dependent outside the
workspace; `make build-sdk` emits its `dist/` and stages the publishable copy.

- **`versions.ts`** — `SPEC_VERSIONS = { kcb: '0.2.0', kinp: '0.2.0', kgp: '0.4.0', kft: '0.3.0',
  kcs: '0.2.0' }`. The single source of the spec versions; `provider-router`'s
  `test_skeleton.py` reads this file and asserts the Python `KCB_VERSION` agrees, so drift is a
  gate failure, not a production surprise.
- **`validator.ts` / `validate.ts`** (imported as `@agora/schemas/validator`) — the ajv
  (draft-2020-12) **structural** validator over the
  six ported koine interchange artifacts: `validate(name, instance): string[]` (empty ⇒ conforms)
  and `ARTIFACT_SCHEMAS` (`grounding-pack`, `canonical-world-export`,
  `entity-grounding-snapshot`, `canonical-graph-export`, `dataset-jsonl-header`, `finetune-job`).
  `validate.ts` is the CLI (`main(argv)`), exit **0** valid / **1** invalid / **2** usage —
  byte-identical to the Python `artifact_validator.py`, the pairing `make check-conformance`
  loops both over.
- **`registry-schema.ts`** — the relation-registry schema + validator: `parseRegistry(value)`,
  `parseVocabulary(files)`, `assertRelationsResolve(document, relations)` (every mapped relation
  must exist in the TSV), `assertSignatureStability(published, candidate)` (rejects an edit that
  moved a published `relation · arity · arg_roles · symmetric`, which would silently re-hash every
  claim id, KGP §3), plus `relationSignature`, `diffSignatures`, and the `RegistryError` class.
- **`relation-registry.ts`** — `RELATION_REGISTRY` (version `0.4.2`, repo `koine`, and the paths
  the data lives at). A *pointer*, never a copy.
- **`axes.ts`** — the three orthogonal axes of a relation and §7.2 egress enforcement:
  `DIALECT_TIERS` (KGP §5), `EGRESS_CLASSES` (§7.2), `TRUST_TIERS`. Egress has teeth in both
  directions — `filterPackForEgress` drops `local-only` at pack construction (producer's duty),
  `assertPackEgress` lets a consumer reject a pack that still carries some (throws `EgressError`);
  `egressOf` fails closed to `local-only`.
- **Protocol types** — `manifest.ts` (KCB §2 capability manifest: `parseManifest`, `Capability`,
  `Port`, `CapabilityManifest`), `agent-card.ts` (A2A AgentCard + the KCB extension),
  `scenario.ts` (KCS conformance-scenario document + `STEP_KINDS`), `identity.ts` (KINP §3.2
  compact ids: `parseKinpId`, `KINP_KINDS`, `worldOf`), `planes.ts` (`PLANES`), `json.ts`
  (`canonicalJson`).

`scripts/regen-koine-*.mjs` derive the vendored snapshot under `src/koine-schemas/` and the test
fixture under `src/fixtures/koine-registry/` from a sibling `koine` checkout; `--check` verifies
the committed copy still matches.

## Usage

```ts
import {
  validate,
  parseVocabulary, parseRegistry, assertRelationsResolve,
  filterPackForEgress, assertPackEgress,
  RELATION_REGISTRY, SPEC_VERSIONS,
} from '@agora/schemas';

// Structural validation of an interchange artifact against a ported koine schema.
const errors = validate('grounding-pack', pack);   // string[] — empty means it conforms
if (errors.length) throw new Error(errors.join('\n'));

// Load + cross-check the shared relation registry (data fetched from koine).
const relations = parseVocabulary(vocabFiles);
assertRelationsResolve(parseRegistry(mappingJson), relations);

// Egress (KGP §7.2), enforced both ways.
const { pack: safe } = filterPackForEgress(pack, relationEgress);  // producer drops local-only
assertPackEgress(receivedPack, relationEgress);                    // consumer rejects a leak

console.log(RELATION_REGISTRY.version, SPEC_VERSIONS.kgp);         // "0.4.2" "0.4.0"
```

CLI form (the same contract the Python validator answers to):

```sh
node schemas/src/validate.ts grounding-pack ./pack.json   # exit 0 valid / 1 invalid / 2 usage
```

The real registry snapshot is available to tests only, off the library surface:

```ts
import { KOINE_VOCABULARY, KOINE_PREDICATE_MAPPING } from '@agora/schemas/fixtures';
```
