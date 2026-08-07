/**
 * Grounding — ingesting a KGP GroundingPack (`grounding-pack.md` §2) into the equivalence
 * layer, and grounding a producer's mention against what was ingested.
 *
 * This is the identity half of "apps are thin producers, the commons bridges the data planes":
 * a producer references world knowledge it did not mint, and has to say *which* canonical thing
 * one of its local records refers to. koine closed that fork
 * ([ADR-0008](../../../koine/decisions/ADR-0008-fabric-producer-adapter.md) decision 5): the
 * assertion is a **`same_as` from the source-local id to the canonical id** — `based_on` across a
 * world boundary that does not inherit identity, and **nothing at all** below threshold. There is
 * no `mentions` relation and coining one is out of scope, so a pack that carries its grounding
 * under any relation KINP does not reserve is refused here with that reason.
 *
 * Three invariants, none of them new — each is a spec clause this module is the enforcement
 * point for:
 *
 * 1. **Merge is a view, computed at query time** (KINP §4.1, §8). Ingest indexes the pack's
 *    `same_as`/`based_on` edges and *nothing else*: no id is rewritten, no record is merged, and
 *    the closure is walked per `resolve` call by the same {@link closureOver} the authority
 *    resolver uses — the walk that never crosses a `based_on` edge (§4.3).
 * 2. **A consumer rejects what it must not hold** (KGP §5, §7.1, §7.2). A pack whose dialect tier
 *    exceeds what this consumer evaluates is refused whole; a pack carrying `local-only` content
 *    is refused whole and reported (never silently stripped — that is a producer bug or a
 *    tampered pack); a record outside the license allowlist is refused per record, with a report.
 * 3. **Below threshold, emit nothing and queue** (KINP §4.5, §11 decision 2). An ingested link
 *    that cannot clear its world's threshold does not enter the equivalence layer at all — it
 *    lands in the review queue, so a weak `same_as` never quietly becomes a merged entity.
 *
 * Nothing here knows who produced the pack. The entity index it builds is whatever the pack's
 * `entities[]` carry, and the matcher over it is a name/key cascade — a producer's own mapping
 * from its records onto the vocabulary is its thin adapter's job (ADR-0008 decision 2), never
 * this module's.
 */
import {
  assertPackEgress,
  DEFAULT_DIALECT,
  dialectAdmits,
  EgressError,
  isDialectTier,
  isJsonObject,
  SPEC_VERSIONS,
  worldOf,
  type DialectTier,
  type EgressViolation,
  type Json,
  type JsonObject,
  type PackLike,
  type RelationEgress,
} from '@agora/schemas';
import {
  admitsLicense,
  classifyLicense,
  DEFAULT_LICENSE_ALLOWLIST,
  hashClaimInput,
  isLinkRelation,
  type LicenseClass,
  type LicenseClassifier,
} from '@agora/knowledge';

import { closureOver } from './authority.ts';
import { createLocalResolver } from './index.ts';
import type { LinkStore } from './persistence.ts';
import { decideLink, mergePolicy, thresholdFor, worldFor, type MergePolicy } from './policy.ts';
import {
  RESOLVER_IDENTITY,
  ResolverUnavailableError,
  type AuthorityResolver,
  type EntityRef,
  type LinkProposal,
  type ProvenanceRef,
  type ReconciliationCandidate,
  type ReconciliationQuery,
  type ReconciliationResult,
  type Resolver,
  type ResolvedIdentity,
} from './types.ts';

/**
 * The two equivalence-layer relations the merged view is computed from (KINP §4.2, §4.3).
 *
 * The other reserved link relations (`part_of`, `instance_of`, `retracts`, `supersedes`) are
 * perfectly valid pack content — they are simply not edges a *merged entity* is a closure over,
 * so they are reported as not-ingested rather than walked. Widening this pair is how the
 * firewall stops being a firewall.
 */
export const EQUIVALENCE_RELATIONS = ['same_as', 'based_on'] as const;

export type EquivalenceRelation = (typeof EQUIVALENCE_RELATIONS)[number];

function isEquivalenceRelation(relation: string): relation is EquivalenceRelation {
  return (EQUIVALENCE_RELATIONS as readonly string[]).includes(relation);
}

/** One `same_as`/`based_on` edge held in the equivalence layer, as a pack stated it. */
export interface EquivalenceLink {
  readonly relation: EquivalenceRelation;
  readonly from: string;
  readonly to: string;
  /** The world the link was asserted in (KINP §5). */
  readonly world: string;
  readonly confidence: number;
  readonly provenance: ProvenanceRef;
  /**
   * Where this edge came from — the `pack_id` it arrived in, or {@link RESOLVER_IDENTITY} when
   * this resolver decided it from a reconciliation. Provenance for the equivalence layer itself.
   */
  readonly source: string;
}

/** A canonical entity a pack carried, indexed for matching. */
export interface GroundingEntity {
  /** The record's `csid` — structurally the KINP entity CURIE (identity.md §7.1). */
  readonly id: string;
  readonly entityType: string;
  /** The world the entity is named into (§5), else the pack's first declared world. */
  readonly world: string;
  /** Name plus aliases, in the order the record gave them. */
  readonly names: readonly string[];
  /** Reconciliation keys — external authority ids and blocking keys (entity-grounding-snapshot). */
  readonly keys: Readonly<Record<string, string>>;
  readonly license: string;
  readonly pack: string;
}

/** Why a record did not enter the equivalence layer or the entity index. Reported, never dropped. */
export const INGEST_REJECTION_CODES = [
  'malformed-entity',
  'malformed-link',
  'not-a-link-relation',
  'not-an-equivalence-edge',
  'license-missing',
  'license-refused',
  'claim-id-mismatch',
] as const;

export type IngestRejectionCode = (typeof INGEST_REJECTION_CODES)[number];

export interface IngestRejection {
  readonly section: 'entities' | 'links';
  /** Position in the pack's own array, so a producer can find the record it sent. */
  readonly index: number;
  readonly id?: string;
  readonly relation?: string;
  readonly code: IngestRejectionCode;
  /** Human-readable, and it names the clause. */
  readonly reason: string;
}

/** What one ingest did — complete or reported, on every axis. */
export interface IngestReport {
  readonly pack: string;
  readonly producer: string;
  readonly worlds: readonly string[];
  readonly kind: 'snapshot' | 'delta';
  /** Entity records indexed for matching. */
  readonly entities: number;
  /** Edges that entered the equivalence layer, and are therefore in the query-time closure. */
  readonly applied: readonly LinkProposal[];
  /** Edges that could not clear their world's threshold — queued, and NOT in the closure. */
  readonly queued: readonly LinkProposal[];
  readonly rejected: readonly IngestRejection[];
  /**
   * Links admitted without re-deriving their claim id, because the record carried no
   * `hash_input` to re-derive it from (KGP §3.1/§4.1). Counted rather than hidden: a check that
   * silently did not run reads exactly like a check that passed.
   */
  readonly unverified: number;
}

/** Why a whole pack was refused. Each code is one clause the pack failed. */
export const PACK_REFUSAL_CODES = [
  'malformed-pack',
  'unsupported-version',
  'dialect-exceeded',
  'local-only',
] as const;

export type PackRefusalCode = (typeof PACK_REFUSAL_CODES)[number];

/** Thrown when a pack is refused whole — a 4xx to whoever submitted it. */
export class GroundingPackError extends Error {
  readonly code: PackRefusalCode;
  /** The §7.2 violations, when the refusal was `local-only`. Reported, never dropped. */
  readonly violations: readonly EgressViolation[];

  constructor(
    code: PackRefusalCode,
    message: string,
    violations: readonly EgressViolation[] = [],
  ) {
    super(message);
    this.name = 'GroundingPackError';
    this.code = code;
    this.violations = violations;
  }
}

/** Confidence of an exact id / reconciliation-key hit — the reference *was* the identifier. */
export const EXACT_ID_CONFIDENCE = 1;
/** Confidence of an exact normalized name or alias hit: strong, but a name is not an id. */
export const EXACT_NAME_CONFIDENCE = 0.95;
/** A fuzzy hit's similarity is scaled by this, so fuzzy never reaches the exact-name tier. */
export const FUZZY_SCALE = 0.9;
/** Below this similarity a fuzzy hit is not a candidate at all. */
export const DEFAULT_FUZZY_THRESHOLD = 0.85;

export interface GroundingOptions {
  /**
   * The resolver consulted for everything the ingested packs cannot answer — a well-formed id's
   * kind and world, and reconciliation once an authority is configured. Defaults to
   * {@link createLocalResolver}, so a resolver with nothing ingested behaves exactly as before.
   */
  readonly delegate?: Resolver;
  /** Merge-policy overrides (§11 decision 2) — the thresholds ingest and matching both read. */
  readonly policy?: Partial<MergePolicy>;
  /** The highest logic tier this consumer can safely evaluate (KGP §5). */
  readonly dialect?: DialectTier;
  /** The §7.1 license-class allowlist. Defaults to public-domain + permissive + attribution. */
  readonly licenses?: readonly LicenseClass[];
  /** A deployment's own license policy, consulted before the built-in table. */
  readonly classifyLicense?: LicenseClassifier;
  /** A relation's declared egress class (§7.2) — the registry loader's `egressFor(project)`. */
  readonly egressOfRelation?: RelationEgress;
  /** Durable store for the applied / queued lists, as the authority resolver takes one. */
  readonly links?: LinkStore;
  /** Minimum similarity for a fuzzy name hit to be a candidate (default 0.85). */
  readonly fuzzyThreshold?: number;
}

/**
 * A resolver whose equivalence layer is fed by ingested grounding packs.
 *
 * It is an {@link AuthorityResolver} because ingest makes the same two decisions reconciliation
 * does — which relation, and apply-or-queue — so the same two ledgers answer "what did this
 * resolver merge, and what is waiting for a human?".
 */
export interface GroundingResolver extends AuthorityResolver {
  /** Ingest one pack (§2). Refuses the pack whole on §5/§7.2; reports per-record refusals. */
  ingest(pack: unknown): IngestReport;
  /** The canonical entities ingest indexed, by id. Read-only: this is a cache, not a store. */
  readonly entities: ReadonlyMap<string, GroundingEntity>;
  /** The equivalence-layer edges the merged view is computed from, in ingest order. */
  readonly equivalence: readonly EquivalenceLink[];
  /** The pack ids ingested so far, in order. */
  readonly packs: readonly string[];
}

export function createGroundingResolver(options: GroundingOptions = {}): GroundingResolver {
  const delegate = options.delegate ?? createLocalResolver();
  const policy = mergePolicy(options.policy);
  const evaluable = options.dialect ?? DEFAULT_DIALECT;
  const allowlist = options.licenses ?? DEFAULT_LICENSE_ALLOWLIST;
  const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const store = options.links;
  const reviewQueue: LinkProposal[] = store ? store.loadReviewQueue() : [];
  const applied: LinkProposal[] = store ? store.loadApplied() : [];
  const entities = new Map<string, GroundingEntity>();
  const equivalence: EquivalenceLink[] = [];
  const packs: string[] = [];

  function record(proposal: LinkProposal): void {
    if (proposal.relation === null || proposal.review) {
      reviewQueue.push(proposal);
      store?.addReview(proposal);
    } else {
      applied.push(proposal);
      store?.addApplied(proposal);
    }
  }

  function ingest(value: unknown): IngestReport {
    const pack = readEnvelope(value, evaluable, options.egressOfRelation);
    const rejected: IngestRejection[] = [];
    const ingested: LinkProposal[] = [];
    const queued: LinkProposal[] = [];
    let unverified = 0;
    let indexed = 0;

    pack.entities.forEach((entry, index) => {
      const refuse = (code: IngestRejectionCode, reason: string): void => {
        rejected.push({ section: 'entities', index, code, reason });
      };
      if (!isJsonObject(entry)) {
        return refuse('malformed-entity', 'an entity record is not a JSON object (KGP §2)');
      }
      const id = str(entry.csid) ?? str(entry.id);
      if (id === undefined) {
        return refuse(
          'malformed-entity',
          'an entity record carries no csid — the KGP §2 entity envelope is keyed by one, ' +
            'structurally the KINP entity CURIE (identity.md §7.1)',
        );
      }
      const license = licenseVerdict(entry, allowlist, options.classifyLicense);
      if (license !== undefined) {
        rejected.push({ section: 'entities', index, id, ...license });
        return;
      }
      entities.set(id, entityFrom(entry, id, pack));
      indexed += 1;
    });

    pack.links.forEach((entry, index) => {
      const refuse = (code: IngestRejectionCode, reason: string, relation?: string): void => {
        rejected.push({
          section: 'links',
          index,
          ...(relation === undefined ? {} : { relation }),
          code,
          reason,
        });
      };
      if (!isJsonObject(entry)) {
        return refuse('malformed-link', 'a link record is not a JSON object (KGP §2)');
      }
      const relation = str(entry.relation);
      if (relation === undefined) {
        return refuse('malformed-link', 'a link record names no relation (KGP §2, KINP §4.2)');
      }
      if (!isLinkRelation(relation)) {
        return refuse(
          'not-a-link-relation',
          `${relation} is not one of KINP's reserved link relations (§4.2) and so cannot be an ` +
            `equivalence-layer edge. Grounding a mention to a canonical entity is a source-local ` +
            `id \`same_as\` (\`based_on\` across a world boundary that does not inherit identity) ` +
            `— koine coins no \`mentions\` relation, and one would sit outside the §4.3 firewall ` +
            `(ADR-0008 decision 5)`,
          relation,
        );
      }
      if (!isEquivalenceRelation(relation)) {
        return refuse(
          'not-an-equivalence-edge',
          `${relation} is a reserved KINP relation but not one the merged-entity view is a ` +
            `closure over (§4.1/§4.3) — it is carried by the pack, not by this equivalence layer`,
          relation,
        );
      }
      const ends = endsOf(entry);
      if (ends === undefined) {
        return refuse(
          'malformed-link',
          `a ${relation} link needs two identifier arguments (registry arity 2, KGP §3.2 rule 1)`,
          relation,
        );
      }
      const license = licenseVerdict(entry, allowlist, options.classifyLicense);
      if (license !== undefined) {
        rejected.push({ section: 'links', index, relation, ...license });
        return;
      }
      const canonical = str(entry.hash_input);
      if (canonical === undefined) unverified += 1;
      else {
        const claim = str(entry.claim) ?? str(entry.id);
        const derived = hashClaimInput(canonical);
        if (claim !== undefined && claim !== derived && !claim.endsWith(`:claim:${derived}`)) {
          return refuse(
            'claim-id-mismatch',
            `the pack carries ${claim} but the claim canonicalizes to ${derived}. A consumer ` +
              `re-derives the id per KGP §3 and rejects a disagreeing one (§4.1) — a mismatch ` +
              `means the two sides normalized differently`,
            relation,
          );
        }
      }

      const link: EquivalenceLink = {
        relation,
        from: ends[0],
        to: ends[1],
        world: str(entry.world) ?? worldOf(ends[0]) ?? pack.worlds[0] ?? policy.defaultWorld,
        confidence: confidenceOf(entry),
        provenance: provenanceOf(entry),
        source: pack.id,
      };
      const proposal = proposalFor(link, policy, pack);
      if (proposal.review) queued.push(proposal);
      else {
        equivalence.push(link);
        ingested.push(proposal);
      }
      record(proposal);
    });

    packs.push(pack.id);
    return {
      pack: pack.id,
      producer: pack.producer,
      worlds: pack.worlds,
      kind: pack.kind,
      entities: indexed,
      applied: ingested,
      queued,
      rejected,
      unverified,
    };
  }

  /**
   * Dereference an identifier into the merged view — §8's `{ entity, same_as_closure[],
   * based_on[], provenance[], attached_assets[] }`.
   *
   * The delegate answers what the identifier *is*; the ingested packs answer what else denotes
   * the same referent. The closure is walked here, per call, over the `same_as` edges only
   * (§4.3) — nothing was ever written merged, which is the whole of §4.1. The `authority` label
   * stays the delegate's: a pack we hold is knowledge we hold, and it never turns a local answer
   * into the authority's.
   */
  async function resolve(ref: EntityRef): Promise<ResolvedIdentity> {
    const base = await delegate.resolve(ref);
    const walked = closureOver(base.id, equivalence);
    if (walked.sameAs.length === 0 && walked.basedOn.length === 0) return base;
    const sameAs = union(base.sameAs, walked.sameAs);
    const basedOn = union(base.basedOn, walked.basedOn).filter((id) => !sameAs.includes(id));
    return {
      ...base,
      sameAs,
      basedOn,
      // A merge keeps ALL provenance (KGP §7): who told us these two ids denote one thing is
      // what the review queue and the trust filter read afterwards.
      provenance: mergeProvenance(base.provenance, provenanceOver([base.id, ...sameAs, ...basedOn])),
    };
  }

  /**
   * Match a descriptor against the ingested entities and decide what, if anything, to assert.
   *
   * With nothing ingested this is not the grounding resolver's question to answer, so it goes
   * straight to the delegate — which, with no authority configured, refuses loudly rather than
   * inventing an id (§4). Once packs are ingested the cascade runs, and the decision is
   * {@link decideLink}'s: the §4.5 relation rule and §11 decision 2's apply-or-queue, unchanged.
   */
  async function reconcile(query: ReconciliationQuery): Promise<ReconciliationResult> {
    if (entities.size === 0) return delegate.reconcile(query);
    const candidates = match(query, entities, fuzzyThreshold, policy);
    if (candidates.length === 0) {
      try {
        return await delegate.reconcile(query);
      } catch (error) {
        // The delegate has no authority to ask, and the packs held nothing that matched. That is
        // the "unknown" case: emit nothing, queue it, and let a reviewer decide (§4.5).
        if (!(error instanceof ResolverUnavailableError)) throw error;
      }
    }
    const world = query.world ?? worldFor(query.of, policy);
    const proposal = decideLink({
      world,
      candidates,
      ...(query.of === undefined ? {} : { subject: query.of }),
      lineageOnly: lineageFrom(query.of),
      policy,
    });
    if (proposal.relation !== null && !proposal.review && proposal.object !== undefined) {
      equivalence.push({
        relation: proposal.relation,
        from: proposal.subject ?? query.query,
        to: proposal.object,
        world,
        confidence: proposal.confidence,
        provenance: { agent: RESOLVER_IDENTITY },
        source: RESOLVER_IDENTITY,
      });
    }
    record(proposal);
    return { candidates, proposal, authority: 'local' };
  }

  /**
   * Candidates the subject can already reach *only* through `based_on` — §4.5's
   * never-promoted-by-transitivity set, read straight off the ingested layer.
   */
  function lineageFrom(subject: string | undefined): string[] {
    if (subject === undefined) return [];
    const walked = closureOver(subject, equivalence);
    return walked.basedOn;
  }

  function provenanceOver(ids: readonly string[]): ProvenanceRef[] {
    const found: ProvenanceRef[] = [];
    for (const link of equivalence) {
      if (!ids.includes(link.from) && !ids.includes(link.to)) continue;
      found.push(link.provenance);
    }
    return found;
  }

  return {
    ingest,
    resolve,
    reconcile,
    entities,
    get equivalence() {
      return equivalence;
    },
    get packs() {
      return packs;
    },
    // Both ledgers include the delegate's, when the delegate keeps one: `reconcile` hands a
    // descriptor the packs cannot match on to the authority, and a proposal that landed in the
    // authority's queue is still a link this resolver is waiting on a reviewer for. A caller
    // reading only the wrapper's own list would silently miss half the queue.
    get reviewQueue() {
      return [...reviewQueue, ...ledgerOf(delegate, 'reviewQueue')];
    },
    get applied() {
      return [...applied, ...ledgerOf(delegate, 'applied')];
    },
  };
}

/** A delegate's own decision ledger, when it is an {@link AuthorityResolver} and keeps one. */
function ledgerOf(delegate: Resolver, name: 'applied' | 'reviewQueue'): readonly LinkProposal[] {
  const held = (delegate as Partial<AuthorityResolver>)[name];
  return Array.isArray(held) ? held : [];
}

/** The §2 envelope, once it has been read and the whole-pack refusals have not fired. */
interface PackEnvelope {
  readonly id: string;
  readonly producer: string;
  readonly worlds: readonly string[];
  readonly kind: 'snapshot' | 'delta';
  readonly dialect: DialectTier;
  readonly entities: readonly Json[];
  readonly links: readonly Json[];
}

/**
 * Read and gate the §2 envelope. Everything here refuses the pack *whole*, because each clause
 * is about the pack rather than a record: a malformed envelope, a spec major this build cannot
 * read, a dialect tier above what the consumer evaluates (§5), or `local-only` content that
 * should never have crossed a boundary at all (§7.2 — "a consumer MUST reject … and report it
 * rather than silently dropping").
 */
function readEnvelope(
  value: unknown,
  evaluable: DialectTier,
  egressOfRelation: RelationEgress | undefined,
): PackEnvelope {
  if (!isJsonObject(value)) {
    throw new GroundingPackError('malformed-pack', 'a grounding pack is a JSON object (KGP §2)');
  }
  const version = str(value.kgp_version);
  if (version === undefined) {
    throw new GroundingPackError(
      'malformed-pack',
      'the pack declares no kgp_version — every pack names the koine spec version it conforms to',
    );
  }
  // Major only. This module reads the §2 envelope and the §4.2 link relations, and both are
  // unchanged across 0.x minors; refusing 0.5.0 against a 0.4.0 pin would reject a conformant
  // producer over an additive revision it is allowed to have moved to first.
  if (version.split('.')[0] !== SPEC_VERSIONS.kgp.split('.')[0]) {
    throw new GroundingPackError(
      'unsupported-version',
      `kgp_version ${version} is a different major than KGP ${SPEC_VERSIONS.kgp}, which is what ` +
        `this build reads`,
    );
  }
  const id = str(value.pack_id);
  if (id === undefined || !/^sha256-[0-9a-f]{64}$/.test(id)) {
    throw new GroundingPackError(
      'malformed-pack',
      `pack_id must be the §2.1 content address \`sha256-<hex>\`, got ${show(value.pack_id)}`,
    );
  }
  const producer = str(value.producer);
  if (producer === undefined || !/^[a-z][a-z0-9-]*$/.test(producer)) {
    throw new GroundingPackError(
      'malformed-pack',
      `producer must be a KINP namespace (\`[a-z][a-z0-9-]*\`, identity.md §3.4), got ` +
        `${show(value.producer)}`,
    );
  }
  const worlds = strings(value.worlds);
  if (worlds.length === 0) {
    throw new GroundingPackError(
      'malformed-pack',
      'a pack is scoped to at least one world (KGP §2, KINP §5)',
    );
  }
  const kind = str(value.kind);
  if (kind !== 'snapshot' && kind !== 'delta') {
    throw new GroundingPackError('malformed-pack', `kind must be snapshot or delta (KGP §6)`);
  }
  if (kind === 'delta' && str(value.basis) === undefined) {
    throw new GroundingPackError(
      'malformed-pack',
      'a delta pack must name the pack_id it applies against (KGP §6)',
    );
  }
  const dialect = value.dialect;
  if (!isDialectTier(dialect)) {
    throw new GroundingPackError(
      'malformed-pack',
      `dialect must be one of the three §5 tiers, got ${show(dialect)} — note local-only is an ` +
        `egress class (§7.2), never a tier`,
    );
  }
  if (!dialectAdmits(evaluable, dialect)) {
    throw new GroundingPackError(
      'dialect-exceeded',
      `the pack is ${dialect} but this consumer evaluates ${evaluable} (KGP §5): a consumer ` +
        `rejects a pack whose tier exceeds what it can safely evaluate`,
    );
  }
  try {
    assertPackEgress(value as unknown as PackLike, egressOfRelation);
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    throw new GroundingPackError('local-only', error.message, error.violations);
  }
  return {
    id,
    producer,
    worlds,
    kind,
    dialect,
    entities: array(value.entities),
    links: array(value.links),
  };
}

/**
 * Turn one ingested edge into the proposal that records what was done with it.
 *
 * §11 decision 2 governs an ingested link exactly as it governs a reconciled one: a `same_as` the
 * producer is not confident enough about is not a merged entity, it is a question. Below the
 * world's threshold the edge stays out of the equivalence layer and goes to the queue.
 */
function proposalFor(
  link: EquivalenceLink,
  policy: MergePolicy,
  pack: PackEnvelope,
): LinkProposal {
  const threshold = thresholdFor(link.world, policy);
  const provenance = `${link.relation} from ${pack.producer}'s pack ${pack.id}`;
  if (link.confidence < threshold) {
    return {
      relation: link.relation,
      subject: link.from,
      object: link.to,
      confidence: link.confidence,
      review: true,
      why:
        `${provenance} carries confidence ${String(link.confidence)}, below the ` +
        `${String(threshold)} threshold for ${link.world} — queued, and NOT merged into the ` +
        `query-time view (§4.5, §11 decision 2)`,
    };
  }
  return {
    relation: link.relation,
    subject: link.from,
    object: link.to,
    confidence: link.confidence,
    review: false,
    why: `${provenance}, at or above the ${String(threshold)} threshold for ${link.world}`,
  };
}

/**
 * The match cascade, most confident tier first: an exact identifier or reconciliation key, an
 * exact normalized name or alias, then a fuzzy name.
 *
 * Every hit at the winning tier is returned, deliberately: two entities that share a normalized
 * name produce two candidates at the same confidence, and {@link decideLink}'s ambiguity margin
 * is what turns that into "emit nothing, queue for review" instead of a coin flip (§4.5).
 */
function match(
  query: ReconciliationQuery,
  entities: ReadonlyMap<string, GroundingEntity>,
  fuzzyThreshold: number,
  policy: MergePolicy,
): ReconciliationCandidate[] {
  const wanted = query.type?.toLowerCase();
  const pool = [...entities.values()].filter(
    (entity) => wanted === undefined || entity.entityType.toLowerCase() === wanted,
  );
  const descriptor = query.query;
  const normalized = normalizeName(descriptor);

  const byId = pool.filter(
    (entity) => entity.id === descriptor || Object.values(entity.keys).includes(descriptor),
  );
  if (byId.length > 0) return byId.map((entity) => candidate(entity, EXACT_ID_CONFIDENCE, policy));

  const byName = pool.filter((entity) =>
    entity.names.some((name) => normalizeName(name) === normalized),
  );
  if (byName.length > 0) {
    return byName.map((entity) => candidate(entity, EXACT_NAME_CONFIDENCE, policy));
  }

  const fuzzy: ReconciliationCandidate[] = [];
  for (const entity of pool) {
    let best = 0;
    for (const name of entity.names) best = Math.max(best, similarity(normalized, normalizeName(name)));
    if (best >= fuzzyThreshold) fuzzy.push(candidate(entity, best * FUZZY_SCALE, policy));
  }
  const limit = query.limit;
  const ranked = fuzzy.sort((a, b) => b.confidence - a.confidence);
  return limit === undefined ? ranked : ranked.slice(0, limit);
}

function candidate(
  entity: GroundingEntity,
  confidence: number,
  policy: MergePolicy,
): ReconciliationCandidate {
  const result: ReconciliationCandidate = {
    id: entity.id,
    score: confidence,
    confidence,
    // Advisory only, and it stays advisory: §11 decision 2 is applied by decideLink, not by a
    // matcher deciding its own hit is good enough.
    match: confidence >= EXACT_ID_CONFIDENCE,
    types: [entity.entityType],
    world: entity.world || worldFor(entity.id, policy),
  };
  const name = entity.names[0];
  return name === undefined ? result : { ...result, name };
}

function entityFrom(record: JsonObject, id: string, pack: PackEnvelope): GroundingEntity {
  const fields = isJsonObject(record.fields) ? record.fields : {};
  const names = union(
    strings(record.name ?? fields.name),
    strings(record.names ?? fields.names),
    strings(record.aliases ?? fields.aliases),
    strings(record.label ?? fields.label),
  );
  const keysRecord = isJsonObject(record.keys)
    ? record.keys
    : isJsonObject(fields.keys)
      ? fields.keys
      : {};
  const keys: Record<string, string> = {};
  for (const [key, value] of Object.entries(keysRecord)) {
    if (typeof value === 'string') keys[key] = value;
  }
  return {
    id,
    entityType: str(record.entityType) ?? str(fields.entityType) ?? 'ent',
    world: worldOf(id) ?? pack.worlds[0] ?? '',
    names,
    keys,
    license: str(record.license) ?? '',
    pack: pack.id,
  };
}

/**
 * The §7.1 admission check over one record: every entity/assertion record carries an SPDX
 * license, and a consumer admits per record and rejects with a report anything outside its
 * allowlist. Returns `undefined` when the record is admitted.
 */
function licenseVerdict(
  record: JsonObject,
  allowlist: readonly LicenseClass[],
  classify: LicenseClassifier | undefined,
): { code: IngestRejectionCode; reason: string } | undefined {
  const license = str(record.license);
  if (license === undefined || license.trim() === '') {
    return {
      code: 'license-missing',
      reason:
        'every entity/assertion record carries an SPDX license (KGP §7.1); this one carries ' +
        'none, so no allowlist can admit it',
    };
  }
  if (admitsLicense(license, allowlist, classify)) return undefined;
  return {
    code: 'license-refused',
    reason:
      `${license} classifies as ${classifyLicense(license, classify)}, which this consumer's ` +
      `§7.1 allowlist (${allowlist.join(', ')}) does not admit`,
  };
}

/** The two identifier ends of a link — the registry's argument order, or the explicit framing. */
function endsOf(record: JsonObject): [string, string] | undefined {
  const args = array(record.args);
  const first = str(args[0]) ?? str(record.subject) ?? str(record.from);
  const second = str(args[1]) ?? str(record.object) ?? str(record.to);
  if (first === undefined || second === undefined) return undefined;
  return [first, second];
}

/**
 * A link's confidence (KINP §7.1, KGP §7). Absent is **0**, not 1: koine's provenance shape
 * requires it, and a link nobody stated a confidence for cannot clear any threshold — it goes to
 * review rather than being merged on an assumption.
 */
function confidenceOf(record: JsonObject): number {
  const own = record.confidence;
  if (typeof own === 'number') return own;
  const prov = isJsonObject(record.provenance) ? record.provenance : {};
  return typeof prov.confidence === 'number' ? prov.confidence : 0;
}

/** The record's PROV-shaped provenance, read into the resolver's `{agent, activity, asserted}`. */
function provenanceOf(record: JsonObject): ProvenanceRef {
  const prov = isJsonObject(record.provenance) ? record.provenance : {};
  const ref: ProvenanceRef = {};
  const agent = str(prov.agent) ?? str(prov.source);
  if (agent !== undefined) ref.agent = agent;
  const activity = str(prov.activity) ?? str(prov.source_url);
  if (activity !== undefined) ref.activity = activity;
  const asserted = str(prov.asserted) ?? str(prov.retrieved_at);
  if (asserted !== undefined) ref.asserted = asserted;
  return ref;
}

function mergeProvenance(
  base: readonly ProvenanceRef[],
  added: readonly ProvenanceRef[],
): ProvenanceRef[] {
  const merged: ProvenanceRef[] = [...base];
  const seen = new Set(merged.map((entry) => JSON.stringify(entry)));
  for (const entry of added) {
    const key = JSON.stringify(entry);
    if (key === '{}' || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * Case/whitespace/diacritic-normalized name — the blocking key the entity-grounding-snapshot
 * schema calls `keys.normalized`. Deterministic and offline: matching must not depend on a
 * locale or a service.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * Sørensen–Dice over character bigrams — a similarity in 0..1 with no dependency and no
 * tuning table. Fuzzy matching only ever *proposes* (§4.5); the threshold and the ambiguity
 * margin are what decide, so the metric needs to be predictable rather than clever.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return a === '' ? 0 : 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = bigrams.get(gram) ?? 0;
    if (left > 0) {
      bigrams.set(gram, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function array(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function str(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function union(...lists: readonly (readonly string[])[]): string[] {
  const seen: string[] = [];
  for (const list of lists) {
    for (const entry of list) if (!seen.includes(entry)) seen.push(entry);
  }
  return seen;
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
