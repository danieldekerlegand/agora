# `@agora/knowledge` — the KGP knowledge-sync bridge

The data-plane bridge for knowledge: **any** producer submits claims in the shared relation
vocabulary, and they arrive at a KGP consumer as a gated, content-addressed
[GroundingPack](../../koine/specs/grounding-pack.md) — with a receipt naming every claim that did
not cross and why.

```
   producer ──claims──▶ [ admit ] ──pack──▶ KGP consumer (dialed at its own address)
                            │
                            └── receipt: pack_id, accepted ids, graded rejections
```

## Why it lives in the commons

Every app that wants its knowledge on the fabric would otherwise re-implement KGP §3's byte
discipline, the relation lookup, and four filters — six chances to diverge. A divergence in §3
does not fail loudly: it silently stops claims from deduping, which is the one property the whole
protocol is built on. Here it is implemented once, against koine's own data, and a producer ships
only its thin mapping onto the vocabulary (ADR-0008).

It is **generic over the producer** by construction. There is no producer allowlist, no
canonicalization for anybody's local schema, and no name of any particular knowledge authority in
the tree — a producer is whoever submits, a consumer is whoever published a KCB manifest with a
knowledge-plane input port. `src/sync.test.ts` proves it by driving the whole path with a
herbarium cataloguing plant specimens.

## What it is not

- **Not a store.** A submission is admitted, delivered and forgotten; `describeKnowledgeSync()`
  reports `retainsClaims: false`. The commons never grows a second copy of anyone's knowledge.
- **Not a vocabulary.** An unpublished relation is refused, never coined (`coinsRelations: false`);
  the vocabulary is loaded from koine over the wire, never vendored (ADR-0001).
- **Not a discovery hop.** The consumer's address comes from its own KCB manifest and is dialed
  directly, so the control plane still carries no payload (ADR-0001 decision 3). This bridge is a
  declared *data-plane* participant — KGP §8's "consumer + producer" role — like any other peer.

## The gate

| Check | Contract |
|---|---|
| relation is published, with the registry's arity/argument order/symmetry | KGP §3.2 rules 1–2 |
| arguments canonicalize to CURIEs and typed literals | §3.2 rules 3–6 |
| `local-only` never crosses — filtered at pack construction | §7.2 |
| the pack's dialect is one the consumer can evaluate | §5 |
| license admitted per record against a class allowlist | §7.1 |
| provenance present; confidence floor; trusted sources | §7 |
| a producer-minted claim id re-derives to the same bytes | §3.1 |

Every refusal is reported with a code and a reason naming the clause — §7.2 requires reporting
rather than silent dropping, and the same rule is applied to all the other axes.

## Use it

```ts
import { loadRelationRegistry } from '@agora/sdk';
import { consumerFromManifest, createKnowledgeSync } from '@agora/knowledge';

const registry = await loadRelationRegistry('https://koine.example/raw');
const sync = createKnowledgeSync({
  consumer: consumerFromManifest(theirManifest),      // an address, dialed directly
  relations: (relation) => registry.relation(relation),
  policy: { dialect: 'grounding-only' },              // what the consumer will hold
});

const receipt = await sync.submit({ producer: 'herbarium', claims });
```

Or run it as a service — `POST /claims` with `{producer, claims}`, `GET /describe` for the
invariants:

```sh
AGORA_KNOWLEDGE_CONSUMER=https://authority.example/kgp/packs \
AGORA_KNOWLEDGE_CONSUMER_IDENTITY=pinakes:agent:authority \
AGORA_KNOWLEDGE_REGISTRY=https://koine.example/raw \
node src/main.ts
```

A refused *claim* is a 200 with reasons on the receipt (admission is per record); a refused
*submission* is a 400; a consumer that refused the pack is a 502 carrying its own words.

## Gate

`make check-knowledge` — eslint + `tsc` + vitest, the same shape as every other TypeScript area.
