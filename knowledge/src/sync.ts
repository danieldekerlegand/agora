/**
 * KGP knowledge sync — the data-plane bridge itself.
 *
 * One submission of claims from *any* producer goes in; a gated, content-addressed KGP pack
 * goes out to one configured consumer, and a receipt comes back naming every claim that did not
 * cross and why. That is the entire service:
 *
 * ```
 *   producer ──claims──▶ [ admit (registry + §5/§7/§7.1/§7.2) ] ──pack──▶ KGP consumer
 *                                     │
 *                                     └── receipt: pack_id, accepted ids, graded rejections
 * ```
 *
 * **Why this lives in the commons and not in each producer.** Every app that wants its knowledge
 * on the fabric otherwise re-implements §3's byte discipline, the relation lookup, and four
 * filters — six chances to diverge, and a divergence in §3 does not fail loudly, it silently
 * stops claims from deduping. Here it is implemented once, against koine's data, and a producer
 * ships only its own thin mapping onto the vocabulary (ADR-0008).
 *
 * **What it is not.** It is not a store: nothing is retained after a submission is delivered, so
 * the fabric never grows a second copy of anybody's knowledge. It is not a discovery hop either
 * — the consumer's address comes from its own KCB manifest and is dialed directly. It sits on
 * the *data* plane, as the §8 "consumer + producer" role, which is exactly why the control-plane
 * no-proxy rule (ADR-0001 decision 3) is not in tension with it: the registry still carries no
 * payload, and this bridge is a declared participant like any other.
 */
import { assertPackEgress, type RelationEgress } from '@agora/schemas';

import {
  admitClaims,
  type AdmissionPolicy,
  type Rejection,
  type RelationLookup,
} from './admission.ts';
import { isClaimLiteral, type Claim, type ClaimArgument } from './claim.ts';
import type { KgpConsumer } from './consumer.ts';
import { buildPack, type GroundingPack } from './pack.ts';

/** One producer's batch of claims. The producer is data on the submission, never configuration. */
export interface ClaimSubmission {
  /** The submitting participant's KINP namespace (identity.md §3.4). */
  readonly producer: string;
  readonly claims: readonly Claim[];
  /** §6 directionality. Defaults to `snapshot`. */
  readonly kind?: 'snapshot' | 'delta';
  /** For a delta, the `pack_id` it applies against (§6). */
  readonly basis?: string | null;
  /** Declares the pack's world scope explicitly; otherwise it is the claims' own worlds. */
  readonly worlds?: readonly string[];
}

/** What the producer gets back: what crossed, what did not, and where it went. */
export interface SyncReceipt {
  readonly producer: string;
  /** KINP identity of the consumer the pack was delivered to. */
  readonly consumer: string;
  readonly delivered: boolean;
  /** The content address of the delivered pack (§2.1); absent when nothing was delivered. */
  readonly pack_id?: string;
  /** The assertion-envelope ids that crossed (`<producer>:claim:sha256-…`). */
  readonly accepted: readonly string[];
  /** Every refused claim, graded. Reported rather than dropped — §7.2, applied to every axis. */
  readonly rejected: readonly Rejection[];
  /** The consumer's own words when it refused the pack. */
  readonly detail?: string;
}

export interface KnowledgeSyncOptions {
  /** Where admitted claims are delivered. */
  readonly consumer: KgpConsumer;
  /** The shared vocabulary — `LoadedRegistry.relation`. The registry is loaded, never vendored. */
  readonly relations: RelationLookup;
  /** What the consumer will hold (§5, §7, §7.1). */
  readonly policy?: AdmissionPolicy;
  /** A relation's declared egress class (§7.2) — `LoadedRegistry.egressFor(project)`. */
  readonly egressOfRelation?: RelationEgress;
  /** The clock, as a seam: a builder that reads the wall clock cannot be tested byte-for-byte. */
  readonly now?: () => string;
}

export interface KnowledgeSync {
  readonly consumer: KgpConsumer;
  /** Admit a batch, build the pack, deliver it, and report. */
  submit(submission: ClaimSubmission): Promise<SyncReceipt>;
}

/** Thrown when a submission is not a submission at all. Distinct from a claim being refused. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export function createKnowledgeSync(options: KnowledgeSyncOptions): KnowledgeSync {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    consumer: options.consumer,
    async submit(submission: ClaimSubmission): Promise<SyncReceipt> {
      const { admitted, rejected } = admitClaims(submission.claims, {
        relations: options.relations,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.egressOfRelation === undefined
          ? {}
          : { egressOfRelation: options.egressOfRelation }),
      });
      const base = {
        producer: submission.producer,
        consumer: options.consumer.identity,
        rejected,
      };
      if (admitted.length === 0) {
        // Nothing to deliver is not a failure — it is a report. An empty pack would still be a
        // pack, and a consumer counting deltas would see one that says nothing.
        return { ...base, delivered: false, accepted: [] };
      }
      const pack: GroundingPack = buildPack(admitted, {
        producer: submission.producer,
        created: now(),
        ...(submission.kind === undefined ? {} : { kind: submission.kind }),
        ...(submission.basis === undefined ? {} : { basis: submission.basis }),
        ...(submission.worlds === undefined ? {} : { worlds: submission.worlds }),
      });
      // Belt and braces on the §7.2 producer obligation: the gate above already refused every
      // local-only claim, so this can only fire if that gate regressed — and a leak must fail
      // loudly here rather than at the consumer, which would only learn of it after receipt.
      assertPackEgress(pack);
      const receipt = await options.consumer.deliver(pack);
      return {
        ...base,
        delivered: receipt.accepted,
        pack_id: pack.pack_id,
        accepted: receipt.accepted ? pack.assertions.concat(pack.links).map((r) => r.id) : [],
        ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
      };
    },
  };
}

/* ── the wire form ───────────────────────────────────────────────────────────────────── */

/**
 * Narrow a submission arriving off the wire, or throw naming the offending path.
 *
 * Producer-agnostic by construction: the only things required are the ones the *contract*
 * requires — a KINP namespace, and claims carrying a world, a relation and its arguments.
 * Everything else about the payload belongs to whoever sent it.
 */
export function parseSubmission(value: unknown): ClaimSubmission {
  const body = object(value, 'submission');
  const producer = body.producer;
  if (typeof producer !== 'string' || producer === '') {
    throw new SyncError('submission.producer must be the producing participant\'s KINP namespace');
  }
  const claims = body.claims;
  if (!Array.isArray(claims)) throw new SyncError('submission.claims must be an array of claims');
  const kind = body.kind;
  if (kind !== undefined && kind !== 'snapshot' && kind !== 'delta') {
    throw new SyncError('submission.kind must be "snapshot" or "delta" (KGP §6)');
  }
  const worlds = body.worlds;
  if (worlds !== undefined && !(Array.isArray(worlds) && worlds.every((w) => typeof w === 'string'))) {
    throw new SyncError('submission.worlds must be an array of world CURIEs');
  }
  const basis = body.basis;
  if (basis !== undefined && basis !== null && typeof basis !== 'string') {
    throw new SyncError('submission.basis must be the pack_id a delta applies against, or null');
  }
  return {
    producer,
    claims: claims.map((claim, index) => parseClaim(claim, `submission.claims[${String(index)}]`)),
    ...(kind === undefined ? {} : { kind }),
    ...(basis === undefined ? {} : { basis }),
    ...(worlds === undefined ? {} : { worlds: worlds as readonly string[] }),
  };
}

function parseClaim(value: unknown, at: string): Claim {
  const body = object(value, at);
  const { world, relation, args } = body;
  if (typeof world !== 'string') throw new SyncError(`${at}.world must be a world CURIE (KINP §5)`);
  if (typeof relation !== 'string') {
    throw new SyncError(`${at}.relation must be a relation name from the shared registry`);
  }
  if (!Array.isArray(args)) throw new SyncError(`${at}.args must be an array of arguments`);
  for (const [index, argument] of args.entries()) {
    if (typeof argument !== 'string' && !isClaimLiteral(argument)) {
      throw new SyncError(
        `${at}.args[${String(index)}] must be an identifier CURIE or a typed literal ` +
          `({type, value}) — KGP §3.2 rules 3 and 5`,
      );
    }
  }
  // Everything past the identity-bearing fields rides through untouched: confidence, valid_time,
  // prov, license and egress are the §7 axes, and this build must not silently drop a field a
  // later KGP minor adds to the envelope.
  return { ...body, world, relation, args: args as readonly ClaimArgument[] } as Claim;
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncError(`${at} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
