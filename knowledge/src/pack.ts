/**
 * Building the KGP §2 GroundingPack the bridge hands to a consumer.
 *
 * A pack is content-addressed (§2.1): `pack_id = sha256(canonical(manifest ⊕ sorted(entities) ⊕
 * sorted(assertions) ⊕ sorted(links)))`, each element canonicalized per §3 and each list sorted
 * by element id. So two bridges given the same admitted claims emit the same `pack_id`, the same
 * way two producers emitting the same fact emit the same claim id — the property the whole
 * protocol is built on, applied one level up.
 *
 * Two things this deliberately does **not** do:
 *
 * - **It does not inline entity records.** A pack from this bridge carries claims and their
 *   provenance; the entities those claims reference are the producer's own records, fetched from
 *   the producer by the consumer that wants them. The bridge is a conduit with a gate, not a
 *   second copy of anybody's knowledge store.
 * - **It does not re-order or re-word a claim.** The record carries the exact `hash_input` bytes
 *   the id was taken over, so a consumer re-verifies the id with one SHA-256 and no
 *   re-implementation of §3.2 — which is the cheapest possible way to catch a bridge that
 *   normalized differently.
 */
import { canonicalJson, DIALECT_TIERS, SPEC_VERSIONS, type DialectTier, type Json } from '@agora/schemas';

import { assertionId, canonicalIdentifier, hashClaimInput, type Claim } from './claim.ts';
import type { AdmittedClaim } from './admission.ts';

/** `<namespace>` grammar for a producer, per the koine grounding-pack schema. */
const PRODUCER = /^[a-z][a-z0-9-]*$/;

/** A pack record's PROV-shaped provenance, as the §2 envelope carries it. */
export interface PackProvenance {
  readonly source: string;
  readonly confidence: number;
  readonly [key: string]: Json | undefined;
}

/** One assertion (or link) record in a pack. */
export interface PackAssertion {
  /** The KINP assertion-envelope id: `<producer>:claim:sha256-<hex>` (identity.md §7.1). */
  readonly id: string;
  /** The bare content-addressed claim id (§3) — what two producers dedup on. */
  readonly claim: string;
  readonly world: string;
  readonly relation: string;
  readonly args: readonly Json[];
  /** The exact §3.1 `HASH_INPUT` the id was taken over, so a consumer can re-verify it. */
  readonly hash_input: string;
  readonly provenance: PackProvenance;
  readonly license: string;
  /** Always `exportable` — a `local-only` record never reaches pack construction (§7.2). */
  readonly egress: 'exportable';
  readonly confidence?: number;
  readonly valid_time?: Json;
  readonly embedding_model?: string;
}

/**
 * A referenced entity record (§2). Modelled so the pack type is complete and so a consumer's
 * egress re-check reads every section — this bridge emits none of them (see the module note).
 */
export interface PackEntity {
  readonly csid: string;
  readonly entityType: string;
  readonly fields: Json;
  readonly provenance: PackProvenance;
  readonly license: string;
  readonly egress?: 'exportable';
}

/** A PROV-shaped activity/agent record the assertions reference (§2). */
export interface PackAgent {
  readonly id: string;
  readonly kind?: string;
  readonly egress?: 'exportable';
}

/** The self-describing pack manifest (§2). */
export interface PackManifest {
  readonly counts: Readonly<Record<string, number>>;
  readonly created: string;
  /** The §7.1 admission ledger: license id → record count. Covers every record in the pack. */
  readonly license_policy: Readonly<Record<string, number>>;
  readonly [key: string]: Json | undefined;
}

/**
 * A KGP §2 GroundingPack, in the JSON serialization (§4 — the lossless twin of the TSV).
 *
 * A `type` rather than an `interface` on purpose: only a type alias gets TypeScript's implicit
 * index signature, and without it a pack cannot be handed to `@agora/schemas`'s own §7.2
 * consumer-side check (`assertPackEgress` takes an open record). Making the egress enforcement
 * reachable is worth more than the nominal shape.
 */
export type GroundingPack = {
  readonly kgp_version: string;
  readonly pack_id: string;
  readonly producer: string;
  readonly worlds: readonly string[];
  readonly kind: 'snapshot' | 'delta';
  readonly basis: string | null;
  readonly dialect: DialectTier;
  readonly entities: readonly PackEntity[];
  readonly assertions: readonly PackAssertion[];
  readonly links: readonly PackAssertion[];
  readonly provenance: readonly PackAgent[];
  readonly manifest: PackManifest;
};

export interface PackOptions {
  /** The KINP namespace of the participant the claims came from. */
  readonly producer: string;
  /** Snapshot (default) or delta (§6). A delta must name the `pack_id` it applies against. */
  readonly kind?: 'snapshot' | 'delta';
  readonly basis?: string | null;
  /** Overrides the worlds derived from the claims — for a snapshot that declares its scope. */
  readonly worlds?: readonly string[];
  /** ISO-8601 UTC. Supplied by the caller: a clock read inside a builder is untestable. */
  readonly created: string;
}

/** Thrown when a pack cannot be built from what it was given. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

/** Build the pack for a batch of already-admitted claims. Nothing is re-checked here. */
export function buildPack(
  admitted: readonly AdmittedClaim[],
  options: PackOptions,
): GroundingPack {
  if (!PRODUCER.test(options.producer)) {
    throw new PackError(
      `producer ${JSON.stringify(options.producer)} is not a KINP namespace ` +
        `(\`[a-z][a-z0-9-]*\`, identity.md §3.4)`,
    );
  }
  const kind = options.kind ?? 'snapshot';
  const basis = options.basis ?? null;
  if (kind === 'delta' && basis === null) {
    throw new PackError('a delta pack must name the pack_id it applies against (KGP §6)');
  }
  if (kind === 'snapshot' && basis !== null) {
    throw new PackError('a snapshot has no basis (KGP §6) — only a delta applies against one');
  }

  const assertions: PackAssertion[] = [];
  const links: PackAssertion[] = [];
  for (const entry of admitted) {
    (entry.link ? links : assertions).push(recordFor(entry, options.producer));
  }
  assertions.sort(byId);
  links.sort(byId);

  const worlds =
    options.worlds !== undefined
      ? [...options.worlds].map(canonicalIdentifier).sort(byBytes)
      : [...new Set(admitted.map((entry) => canonicalIdentifier(entry.claim.world)))].sort(byBytes);
  if (worlds.length === 0) {
    throw new PackError('a pack is scoped to at least one world (KGP §2, KINP §5)');
  }

  const manifest: PackManifest = {
    counts: { entities: 0, assertions: assertions.length, links: links.length },
    created: options.created,
    license_policy: licensePolicy([...assertions, ...links]),
  };

  const body = {
    kgp_version: SPEC_VERSIONS.kgp,
    producer: options.producer,
    worlds,
    kind,
    basis,
    dialect: dialectOf(admitted),
    entities: [] as readonly PackEntity[],
    assertions,
    links,
    provenance: [] as readonly PackAgent[],
    manifest,
  };
  return { ...body, pack_id: packId(body) };
}

/**
 * §2.1's content address over a pack body: the canonical bytes of the manifest and the three
 * id-sorted record lists. `canonicalJson` supplies the byte discipline (sorted keys, no
 * insignificant whitespace) that §3 requires of every content address in the fabric.
 */
export function packId(body: {
  readonly manifest: PackManifest;
  readonly entities: readonly PackEntity[];
  readonly assertions: readonly PackAssertion[];
  readonly links: readonly PackAssertion[];
}): string {
  // One cast, at the hashing boundary: every field above is JSON by construction, but the
  // structural types above do not carry `Json`'s index signature.
  const parts = {
    manifest: body.manifest,
    entities: body.entities,
    assertions: body.assertions,
    links: body.links,
  } as unknown as Json;
  return hashClaimInput(canonicalJson(parts));
}

/** The highest dialect tier any admitted claim needs — what a consumer must be able to evaluate. */
export function dialectOf(admitted: readonly AdmittedClaim[]): DialectTier {
  let highest = 0;
  for (const entry of admitted) {
    highest = Math.max(highest, DIALECT_TIERS.indexOf(entry.row.tier));
  }
  return DIALECT_TIERS[highest] ?? 'grounding-only';
}

function recordFor(entry: AdmittedClaim, producer: string): PackAssertion {
  const claim: Claim = entry.claim;
  const confidence = claim.prov?.confidence ?? claim.confidence ?? 1;
  const provenance: PackProvenance = {
    ...claim.prov,
    source: claim.prov?.source ?? producer,
    confidence,
  };
  return {
    id: assertionId(producer, entry.id),
    claim: entry.id,
    world: canonicalIdentifier(claim.world),
    relation: claim.relation,
    args: claim.args as readonly Json[],
    hash_input: entry.canonical,
    provenance,
    license: claim.license ?? '',
    egress: 'exportable',
    ...(claim.confidence === undefined ? {} : { confidence: claim.confidence }),
    ...(claim.valid_time === undefined ? {} : { valid_time: claim.valid_time }),
    ...(claim.embedding_model === undefined ? {} : { embedding_model: claim.embedding_model }),
  };
}

/** license id → record count, covering every record in the pack (§7.1). */
function licensePolicy(records: readonly PackAssertion[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.license] = (counts[record.license] ?? 0) + 1;
  }
  return counts;
}

function byId(a: PackAssertion, b: PackAssertion): number {
  return byBytes(a.id, b.id);
}

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
