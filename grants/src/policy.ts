/**
 * Ceiling policy — the operator's say over how much a minted grant may authorize.
 *
 * KCB §5 gives the grant a `budget_units` ceiling so that "a cross-participant chain (knowledge
 * producer → media producer → paid model) cannot exceed the caller's authorized spend". The
 * ceiling on a grant is the caller's; the ceiling on *what may be asked for* is the host's, and
 * that is this file: a small set of per-scope caps an operator hands the issuer at boot, applied
 * to every mint before anything is signed.
 *
 * Three rules, and the first one is the one everything else follows from:
 *
 * - **An absent ceiling is unbounded** (`grant.ts`, and both relying parties) — so a request that
 *   states no ceiling is a request for *more* than any cap, not a request outside the policy.
 *   That is what makes "an authorization input the caller failed to state can never widen what
 *   the caller may do" hold at issuance the same way `apr_grant` holds it at enforcement: the
 *   absent ceiling takes the cap, or is refused, exactly as an over-cap number would be.
 * - **The tightest applicable cap binds.** A scope can be reached by more than one cap — a grant
 *   on `world/*` is spendable on `world/x`, so a cap on `world/x` constrains it — and where
 *   several apply the policy resolves to the smallest. Specificity ordering would make the same
 *   policy mean different things depending on how it was written down; "the smallest wins" fails
 *   closed and reads the same in any order.
 * - **A cap only ever narrows.** {@link applyCeilingPolicy} can lower a requested ceiling or
 *   refuse the request. There is deliberately no way to spell a policy that raises one — a
 *   policy that could hand out more than was asked for is not a cap.
 *
 * Which of the two answers an over-cap request gets is the host's call ({@link CeilingPolicyMode}):
 * `clamp` mints the grant at the cap, `refuse` hands back a 403. Clamping is the friendlier
 * default for a fabric where a caller asks for a generous ceiling and takes what it is given;
 * refusing is right where a caller that would overspend should find out at the mint rather than
 * discover a smaller ceiling at some later gate.
 */
import {
  CEILING_KEY,
  GrantError,
  grantToken,
  isGrantVerb,
  parseCeiling,
  scopeCovers,
  type Grant,
  type GrantVerb,
} from './grant.ts';

/** What an over-cap (or unstated) ceiling gets: the cap itself, or a refusal. */
export type CeilingPolicyMode = 'clamp' | 'refuse';

/** One operator-set cap: the most a grant reaching this scope may be minted to carry. */
export interface CeilingCap {
  /** The scope it binds to, in the grant's own spelling — `*`, `world/*`, or an exact scope. */
  readonly scope: string;
  /** The verb it binds to. Absent binds every verb. */
  readonly verb?: GrantVerb | undefined;
  /** The most `budget_units` a grant on this scope may carry. */
  readonly max_units: number;
}

/** The whole policy: how to answer, and what the caps are. */
export interface CeilingPolicy {
  readonly mode: CeilingPolicyMode;
  readonly caps: readonly CeilingCap[];
}

/** No caps declared — every ceiling is the caller's business, including an absent one. The
 * default, because a host that has said nothing about spend has not authorized a limit either. */
export const UNCAPPED_POLICY: CeilingPolicy = { mode: 'clamp', caps: [] };

/**
 * Whether two scopes overlap at all — either covers the other.
 *
 * Coverage alone would be too narrow in one direction that matters: a cap on `world/x` does not
 * *cover* a request for `world/*`, but the grant that request mints is spendable on `world/x`,
 * so the cap has to bind it. Intersection is the fail-closed reading of "this cap is reachable
 * from this grant".
 */
export function scopesIntersect(a: string, b: string): boolean {
  return scopeCovers(a, b) || scopeCovers(b, a);
}

/** The cap binding `verb` on `scope`, or nothing if the policy declares none reaching it. */
export function capFor(
  policy: CeilingPolicy,
  verb: string,
  scope: string,
): CeilingCap | undefined {
  let tightest: CeilingCap | undefined;
  for (const cap of policy.caps) {
    if (cap.verb !== undefined && cap.verb !== verb) continue;
    if (!scopesIntersect(cap.scope, scope)) continue;
    if (tightest === undefined || cap.max_units < tightest.max_units) tightest = cap;
  }
  return tightest;
}

/**
 * Apply the policy to a grant about to be minted: return it unchanged, return it clamped to the
 * cap, or refuse it.
 *
 * The refusal is a **403** and not a 422: the request is perfectly readable, it just asks for
 * more authority than the host grants on that scope — the same grading `apr_grant:parse/1` uses
 * to separate "you may not" from "I cannot read this".
 */
export function applyCeilingPolicy(policy: CeilingPolicy, grant: Grant): Grant {
  const cap = capFor(policy, grant.verb, grant.scope);
  if (cap === undefined) return grant;
  const requested = grant.budget_units;
  if (requested !== undefined && requested <= cap.max_units) return grant;
  if (policy.mode === 'refuse') {
    throw new GrantError(
      403,
      requested === undefined
        ? `${grantToken(grant)} needs a ${CEILING_KEY} of at most ${cap.max_units}: policy caps ` +
          `${capToken(cap)} and an unstated ceiling is unbounded`
        : `${grantToken(grant)} may not carry ${requested} ${CEILING_KEY}: policy caps ` +
          `${capToken(cap)} at ${cap.max_units}`,
    );
  }
  return { ...grant, budget_units: cap.max_units };
}

/** Read a policy off configuration — a JSON file, an env var, a host's own settings object. */
export function parseCeilingPolicy(input: unknown): CeilingPolicy {
  if (input === undefined || input === null) return UNCAPPED_POLICY;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GrantError(422, 'a ceiling policy is an object with a "mode" and a "caps" list');
  }
  const record = input as Record<string, unknown>;
  const mode = record.mode ?? UNCAPPED_POLICY.mode;
  if (mode !== 'clamp' && mode !== 'refuse') {
    throw new GrantError(422, `a ceiling policy's "mode" is "clamp" or "refuse", not ${JSON.stringify(mode)}`);
  }
  const caps = record.caps ?? [];
  if (!Array.isArray(caps)) {
    throw new GrantError(422, 'a ceiling policy\'s "caps" is a list of {scope, verb?, max_units}');
  }
  return { mode, caps: caps.map(parseCeilingCap) };
}

function parseCeilingCap(input: unknown): CeilingCap {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GrantError(422, 'a ceiling cap is an object like {"scope":"*","max_units":100}');
  }
  const record = input as Record<string, unknown>;
  const scope = record.scope;
  if (typeof scope !== 'string' || scope.trim() !== scope || scope === '') {
    throw new GrantError(422, `a ceiling cap's "scope" must be a grant scope, not ${JSON.stringify(scope)}`);
  }
  const verb = record.verb;
  if (verb !== undefined && !isGrantVerb(verb)) {
    throw new GrantError(422, `a ceiling cap's "verb" must be a KCB §4 verb, not ${JSON.stringify(verb)}`);
  }
  // A cap read the way a ceiling is read, minus the one liberty: an absent cap is not a cap.
  // `parseCeiling` already refuses a malformed number, so a typo can never widen a cap either.
  const max_units = parseCeiling(record.max_units);
  if (max_units === undefined) {
    throw new GrantError(422, `a ceiling cap on ${JSON.stringify(scope)} must state its "max_units"`);
  }
  return { scope, ...(verb === undefined ? {} : { verb }), max_units };
}

/** How a cap reads in a refusal — the `<verb>:<scope>` it binds, `*` where it binds every verb. */
function capToken(cap: CeilingCap): string {
  return `${cap.verb ?? '*'}:${cap.scope}`;
}
