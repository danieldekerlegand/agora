/**
 * The capability grant itself — `koine/specs/capability-bus.md` §5.
 *
 * "Invocation requires a capability token naming the granted verb + scope — `invoke:compose`,
 * `subscribe:world/consensus-reality`, `fetch:asset`. Grants are per-capability, per-world, and
 * carry a spend ceiling (`budget_units`)."
 *
 * KCB fixes the *shape* and leaves issuance to the control-plane host's infra. This file is the
 * shape, spelled once for this workspace, and it is deliberately a **mirror of what the relying
 * parties already do** rather than a second reading of the spec:
 *
 * - `provider-router-erl/src/apr_grant.erl` — `parse/1`, `permits/3`, `ceiling/1`
 * - `trainer/src/agora_trainer/grant.py` — `Grant.admits/1`
 *
 * An issuer that disagrees with either one mints tokens that get refused at the door, so
 * `relying-party.test.ts` reads both of those files off disk and fails when the verb set, the
 * ceiling key, the wildcard spellings or the ungated rule drift apart. Nothing here is a
 * *narrowing* of the relying parties: whatever they accept, this mints; whatever they refuse,
 * this refuses at mint time.
 *
 * Two rules carried across verbatim, because they are the whole point of the ceiling:
 *
 * - **A malformed ceiling is a refusal, never "no ceiling".** {@link parseCeiling} throws where
 *   `apr_cost:parse_ceiling/1` throws — treating a typo as unbounded spend is how a chain
 *   escapes the caller's authorized spend.
 * - **An absent ceiling is unbounded, and only an absent one.** `null`/omitted is the offline
 *   default both relying parties already implement (`budget_units => undefined`, `None`).
 */

import type { ManifestSigning } from '@agora/schemas';

/** The §4 verbs. A grant may name any of them; `discover`/`describe` are unauthenticated reads
 * that no relying party checks, but they are mintable so an over-broad token is refused as "not
 * covering this scope" rather than as a syntax error the caller cannot act on. */
export const GRANT_VERBS = ['discover', 'describe', 'invoke', 'subscribe', 'fetch'] as const;

export type GrantVerb = (typeof GRANT_VERBS)[number];

/** The spend-ceiling key, spelled the same in the manifest, the router and the trainer. */
export const CEILING_KEY = 'budget_units';

/** The scope that covers everything — `apr_grant:scope_matches/2`, and the manifest's
 * `world_pattern` spelling for a world-agnostic producer (KCB delta J). */
export const WILDCARD_SCOPE = '*';

/** The suffix that makes a scope cover its subtree (`world/*`). */
export const SUBTREE_SUFFIX = '/*';

/**
 * A capability grant, in the shape a relying party parses.
 *
 * `verb` + `scope` are the two halves of the `<verb>:<scope>` token; a grant is equally valid
 * spelled either way and {@link parseGrant} accepts both, exactly as `apr_grant:parse/1` does.
 */
export interface Grant {
  readonly verb: GrantVerb;
  readonly scope: string;
  /** The spend ceiling in the capability's meter. Absent = unbounded (the offline default). */
  readonly budget_units?: number | undefined;
}

/**
 * A refusal, carrying the HTTP status the surface should answer with — the same 403-vs-422
 * grading `apr_grant:parse/1` returns.
 *
 * `403` the caller is not authorized (absent or too narrow a grant); `422` the caller sent
 * something unreadable (an unknown verb, a malformed ceiling, a token that is not a token).
 */
export class GrantError extends Error {
  readonly status: 403 | 422;

  constructor(status: 403 | 422, message: string) {
    super(message);
    this.name = 'GrantError';
    this.status = status;
  }
}

export function isGrantVerb(value: unknown): value is GrantVerb {
  return typeof value === 'string' && (GRANT_VERBS as readonly string[]).includes(value);
}

/** The grant back in its token spelling — what a log line or a refusal quotes. */
export function grantToken(grant: Pick<Grant, 'verb' | 'scope'>): string {
  return `${grant.verb}:${grant.scope}`;
}

/**
 * Split a `<verb>:<scope>` token. Splits on the FIRST colon, as `binary:split/2` does, so a
 * scope may contain colons of its own without changing which half is the verb.
 */
export function parseGrantToken(token: string): { verb: GrantVerb; scope: string } {
  const at = token.indexOf(':');
  const verb = at === -1 ? '' : token.slice(0, at);
  const scope = at === -1 ? '' : token.slice(at + 1);
  if (at === -1 || scope === '') {
    throw new GrantError(422, `a grant token is "<verb>:<scope>", not ${JSON.stringify(token)}`);
  }
  if (!isGrantVerb(verb)) {
    throw new GrantError(422, `unknown grant verb ${JSON.stringify(verb)}`);
  }
  return { verb, scope };
}

/**
 * Read a spend ceiling the way `apr_cost:parse_ceiling/1` reads one: absent/null is unbounded,
 * a number or a numeric string is clamped at zero, and anything else — a boolean, an object, a
 * word — is a refusal rather than a silent absence.
 */
export function parseCeiling(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw ceilingError(raw);
    return Math.max(raw, 0);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const value = trimmed === '' ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(value)) throw ceilingError(raw);
    return Math.max(value, 0);
  }
  throw ceilingError(raw);
}

function ceilingError(raw: unknown): GrantError {
  return new GrantError(
    422,
    `${CEILING_KEY} must be a number of budget units, not ${JSON.stringify(raw) ?? String(raw)}`,
  );
}

/**
 * Whether a granted scope covers a wanted one: `*` covers everything, a trailing `/*` covers its
 * subtree, anything else is exact. `apr_grant:scope_matches/2`, transliterated.
 */
export function scopeCovers(granted: string, wanted: string): boolean {
  if (granted === WILDCARD_SCOPE) return true;
  if (granted.endsWith(SUBTREE_SUFFIX)) {
    // `world/*` covers `world/` and everything under it — the prefix keeps the separator.
    return wanted.startsWith(granted.slice(0, -1));
  }
  return granted === wanted;
}

/** Whether `grant` covers `verb` on `scope` — `apr_grant:permits/3`. */
export function permits(grant: Grant, verb: string, scope: string): boolean {
  return grant.verb === verb && scopeCovers(grant.scope, scope);
}

/** Whether a run whose admission-time estimate is `estimate` fits under the grant's ceiling —
 * the trainer's `Grant.admits`. An absent ceiling admits any estimate. */
export function admits(grant: Grant, estimate: number): boolean {
  return grant.budget_units === undefined || estimate <= grant.budget_units;
}

/**
 * The scope a subscription to `topic` needs granting for — `apr_grant:required_scope/1`. A world
 * topic keeps its `world/<world>` spelling (§5's own example); a capability topic reduces to the
 * capability name, matching how `invoke` grants are spelled in the manifest.
 */
export function requiredScope(topic: string): string {
  if (topic.startsWith('world/')) return topic;
  if (topic.startsWith('capability/')) return topic.slice('capability/'.length);
  return topic;
}

/**
 * Parse a presented grant — a token string, or an object carrying `scope` (optionally split into
 * `verb` + `scope`) and an optional `budget_units`. `apr_grant:parse/1`, refusals and all.
 *
 * This is the relying-party half, living in the issuer's workspace on purpose: an issuer that
 * cannot read back what it minted has no way to attenuate it (US-3) or to verify it (US-2), and
 * downstream enforcement gets one shape to consume rather than a third derivation of §5.
 */
export function parseGrant(input: unknown): Grant {
  if (input === undefined || input === null || input === '') {
    throw new GrantError(403, 'a capability grant is required (capability-bus.md §5)');
  }
  if (typeof input === 'string') {
    return { ...parseGrantToken(input), budget_units: undefined };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GrantError(422, 'a grant must be a capability token or an object');
  }
  const record = input as Record<string, unknown>;
  const scope = record.scope;
  if (typeof scope !== 'string' || scope === '') {
    throw new GrantError(422, 'a grant must carry a "scope" like "subscribe:world/<world>"');
  }
  const verb = record.verb;
  const token = typeof verb === 'string' && verb !== '' ? `${verb}:${scope}` : scope;
  const ceiling = parseCeiling(record[CEILING_KEY]);
  return { ...parseGrantToken(token), budget_units: ceiling };
}

/**
 * A signature in the §5 `{key_id, alg}` shape — the one manifests and KGP packs share — plus
 * the detached bytes it covers.
 */
export interface GrantSignature extends ManifestSigning {
  /** base64url over the canonical grant bytes (`verify.ts`). */
  readonly value: string;
}

/**
 * A minted grant on the wire: the §5 grant shape, the principal it was minted for, when it
 * stops counting, and the signature over all of it.
 *
 * The **expiry is not optional**. An issuer that keeps no ledger of what it minted — this one
 * keeps none, deliberately — has no revocation list to add a grant to, so ageing out is the
 * only way a credential ever stops being one. A grant that never expires could not be withdrawn
 * by anybody, which is a worse property than any lifetime a host might pick.
 *
 * The relying parties read past it: `apr_grant:parse/1` and the trainer's `Grant` take `verb`,
 * `scope` and `budget_units` and ignore what they do not know, so an expiring grant is still
 * exactly the grant they already parse. Enforcement of the expiry belongs with whoever verifies
 * the signature — `verifyGrant` in this workspace, and downstream enforcement importing it.
 */
export interface IssuedGrant extends Grant {
  /** Whatever principal the host names. Opaque to the issuer, covered by the signature. */
  readonly grantee: string;
  /** ISO-8601 UTC. After this instant the grant verifies as expired, and is refused. */
  readonly expires_at: string;
  /**
   * Present on a grant derived from another (`attenuate.ts`): a fingerprint of the parent it
   * was narrowed from, so a chain is attributable after the fact without carrying the parent
   * around. Absent on a grant minted from a request.
   *
   * It is a *fingerprint* and not the parent itself because the parent is somebody else's
   * credential: a child that embedded it would hand every downstream hop the very authority
   * attenuation exists to withhold.
   */
  readonly derived_from?: string | undefined;
  readonly signature: GrantSignature;
}
