/**
 * Admission — the gate every claim passes through before it can be delivered anywhere.
 *
 * The bridge's whole job is to be the place where "some producer says X" becomes "a KGP-shaped
 * claim a consumer may hold", and that judgement is made against **koine's data**, never against
 * anything about who is submitting:
 *
 * | Check | Contract | Why it is here and not in the producer |
 * |---|---|---|
 * | relation is published | KGP §3.2 rule 1 | the vocabulary is shared; a producer that coins one has forked the registry |
 * | arity / argument order / symmetry | §3.2 rules 1–2 | the signature is the registry's, so the claim id is reproducible |
 * | arguments canonicalize | §3.2 rules 3–6 | an id that cannot be re-derived cannot dedup |
 * | egress | §7.2 | `local-only` must be filtered at pack construction, not by the consumer |
 * | dialect | §5 | a consumer must reject a pack whose tier exceeds what it can evaluate |
 * | license | §7.1 | admit per record, reject with a report |
 * | provenance / confidence / trust | §7 | "who told us this, and how sure were they" is always answerable |
 *
 * Nothing here knows a mapping from anybody's local predicates onto the vocabulary — that is the
 * producer's thin adapter (ADR-0008), and a copy of it in the commons would be a second source of
 * truth for one caller's schema. What arrives here is already in the vocabulary or is rejected.
 *
 * Every rejection is **graded and reported**: a code, the claim's index, and a reason naming the
 * clause it failed. §7.2 requires reporting rather than silently dropping, and the same rule is
 * applied to all the other axes — a filter nobody can see is indistinguishable from data loss.
 */
import {
  DEFAULT_DIALECT,
  dialectAdmits,
  egressOf,
  type DialectTier,
  type RelationEgress,
  type RelationRow,
} from '@agora/schemas';

import { canonicalClaim, ClaimError, hashClaimInput, type Claim } from './claim.ts';
import {
  admitsLicense,
  classifyLicense,
  DEFAULT_LICENSE_ALLOWLIST,
  type LicenseClass,
  type LicenseClassifier,
} from './license.ts';

/** A relation's published signature, or `undefined` — `LoadedRegistry.relation`'s shape. */
export type RelationLookup = (relation: string) => RelationRow | undefined;

/** Why a claim did not cross. Each code names exactly one clause of the contract. */
export const REJECTION_CODES = [
  'unknown-relation',
  'arity-mismatch',
  'malformed-argument',
  'malformed-world',
  'local-only',
  'dialect-exceeded',
  'license-missing',
  'license-refused',
  'provenance-missing',
  'untrusted-source',
  'confidence-below-threshold',
  'claim-id-mismatch',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

/** One refused claim, with its reason. Reported, never dropped in silence. */
export interface Rejection {
  /** Position in the submitted batch, so a producer can find the record it sent. */
  readonly index: number;
  readonly relation: string;
  readonly code: RejectionCode;
  /** Human-readable, and it names the clause — a reason a producer can act on. */
  readonly reason: string;
}

/** A claim that passed, with the bytes and the id derived from it. */
export interface AdmittedClaim {
  readonly claim: Claim;
  /** The registry row the claim was checked against. */
  readonly row: RelationRow;
  /** The §3.1 `HASH_INPUT` — kept so a receipt can show what was actually hashed. */
  readonly canonical: string;
  /** `sha256-<hex>`, the content-addressed claim id (§3). */
  readonly id: string;
  /** The §7.1 class of the record's license. */
  readonly licenseClass: LicenseClass;
  /** True when the relation is one of KINP's reserved ones, so the pack files it under `links`. */
  readonly link: boolean;
}

/** What a consumer will hold, as policy over the four first-class axes (§5, §7, §7.1, §7.2). */
export interface AdmissionPolicy {
  /** The highest logic tier the consumer can safely evaluate (§5). Defaults to `grounding-only`. */
  readonly dialect?: DialectTier;
  /** The §7.1 license-class allowlist. Defaults to public-domain + permissive + attribution. */
  readonly licenses?: readonly LicenseClass[];
  /** A deployment's own license policy, consulted before the built-in table. */
  readonly classifyLicense?: LicenseClassifier;
  /** Minimum `confidence` (§7). Claims below it are refused, not down-weighted. */
  readonly minConfidence?: number;
  /** `prov.source` allowlist (§7). Empty/absent trusts every source. */
  readonly trustedSources?: readonly string[];
}

export interface AdmissionOptions {
  /** The shared vocabulary — `LoadedRegistry.relation` from `@agora/sdk`, or a test's stub. */
  readonly relations: RelationLookup;
  readonly policy?: AdmissionPolicy;
  /** A relation's declared egress class (§7.2) — `LoadedRegistry.egressFor(project)`. */
  readonly egressOfRelation?: RelationEgress;
}

/** The verdict over a batch: what may cross, and what may not with the reason. */
export interface Admission {
  readonly admitted: readonly AdmittedClaim[];
  readonly rejected: readonly Rejection[];
}

/** KINP's reserved relations — assertions the pack files under `links` rather than `assertions`. */
export const LINK_RELATIONS = [
  'same_as',
  'based_on',
  'part_of',
  'instance_of',
  'retracts',
  'supersedes',
] as const;

export function isLinkRelation(relation: string): boolean {
  return (LINK_RELATIONS as readonly string[]).includes(relation);
}

/** Run one batch of claims through the gate. Pure: it reads policy and data, and returns both. */
export function admitClaims(
  claims: readonly Claim[],
  options: AdmissionOptions,
): Admission {
  const admitted: AdmittedClaim[] = [];
  const rejected: Rejection[] = [];
  claims.forEach((claim, index) => {
    const verdict = admitClaim(claim, index, options);
    if ('code' in verdict) rejected.push(verdict);
    else admitted.push(verdict);
  });
  return { admitted, rejected };
}

function admitClaim(
  claim: Claim,
  index: number,
  options: AdmissionOptions,
): AdmittedClaim | Rejection {
  const policy = options.policy ?? {};
  const refuse = (code: RejectionCode, reason: string): Rejection => ({
    index,
    relation: claim.relation,
    code,
    reason,
  });

  const row = options.relations(claim.relation);
  if (row === undefined) {
    return refuse(
      'unknown-relation',
      `${claim.relation} is not published in the shared relation registry ` +
        `(koine registry/relations.tsv + relations/<domain>.tsv). A relation the vocabulary does ` +
        `not declare has no fixed arity or argument order, so its claim id is not reproducible ` +
        `(KGP §3.2 rule 1) — add it to the registry by PR rather than emitting it`,
    );
  }

  let canonical: string;
  try {
    canonical = canonicalClaim(claim, row);
  } catch (error) {
    if (error instanceof ClaimError) return refuse(error.code, error.message);
    throw error;
  }

  // §7.2 first: `local-only` never leaves its tier, whatever else is true of the record.
  const egress = egressOf(
    { relation: claim.relation, ...(claim.egress === undefined ? {} : { egress: claim.egress }) },
    options.egressOfRelation,
  );
  if (egress !== 'exportable') {
    return refuse(
      'local-only',
      `${claim.relation} is ${egress} (KGP §7.2): it must never cross a project boundary, and ` +
        `the filter is applied here, at pack construction, not left to the consumer`,
    );
  }

  const evaluable = policy.dialect ?? DEFAULT_DIALECT;
  if (!dialectAdmits(evaluable, row.tier)) {
    return refuse(
      'dialect-exceeded',
      `${claim.relation} needs the ${row.tier} dialect but the consumer declares ${evaluable} ` +
        `(KGP §5): a producer ships the lowest tier that carries the content, and a consumer ` +
        `rejects a pack whose tier exceeds what it can safely evaluate`,
    );
  }

  if (claim.license === undefined || claim.license.trim() === '') {
    return refuse(
      'license-missing',
      `every entity/assertion record carries an SPDX license (KGP §7.1); this one carries none, ` +
        `so no allowlist can admit it`,
    );
  }
  const allowlist = policy.licenses ?? DEFAULT_LICENSE_ALLOWLIST;
  const licenseClass = classifyLicense(claim.license, policy.classifyLicense);
  if (!admitsLicense(claim.license, allowlist, policy.classifyLicense)) {
    return refuse(
      'license-refused',
      `${claim.license} classifies as ${licenseClass}, which the consumer's §7.1 allowlist ` +
        `(${allowlist.join(', ')}) does not admit`,
    );
  }

  const source = claim.prov?.source;
  if (source === undefined || source.trim() === '') {
    return refuse(
      'provenance-missing',
      `the claim carries no prov.source (KGP §2/§7): provenance rides on every assertion so ` +
        `"who told us this" stays answerable after a merge, and a merge keeps ALL of it`,
    );
  }
  const trusted = policy.trustedSources;
  if (trusted !== undefined && trusted.length > 0 && !trusted.includes(source)) {
    return refuse(
      'untrusted-source',
      `prov.source ${source} is not in the consumer's trusted set (${trusted.join(', ')}) — ` +
        `the §7 provenance filter`,
    );
  }

  const confidence = claim.confidence ?? claim.prov?.confidence;
  const floor = policy.minConfidence;
  if (floor !== undefined && (confidence ?? 0) < floor) {
    return refuse(
      'confidence-below-threshold',
      `confidence ${String(confidence ?? 'absent')} is below the consumer's floor ` +
        `${String(floor)} (the §7 confidence filter)`,
    );
  }

  const id = hashClaimInput(canonical);
  if (claim.id !== undefined && claim.id !== id && !claim.id.endsWith(`:claim:${id}`)) {
    return refuse(
      'claim-id-mismatch',
      `the producer minted ${claim.id} but this claim canonicalizes to ${id}. The id is a hash ` +
        `of ${JSON.stringify(canonical)} (KGP §3.1) and nothing else — a mismatch means the two ` +
        `sides normalized differently, and cross-producer dedup would silently stop working`,
    );
  }

  return { claim, row, canonical, id, licenseClass, link: isLinkRelation(row.relation) };
}
