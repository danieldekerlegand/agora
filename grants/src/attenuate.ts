/**
 * Attenuation — deriving a child grant from a grant somebody already holds.
 *
 * This is the mechanism behind KCB §5's whole reason for putting a ceiling on a grant: *"a
 * cross-participant chain (knowledge producer → media producer → paid model) cannot exceed the
 * caller's authorized spend"*. A chain is participants calling participants, and a participant
 * that must hand its own credential downstream to get work done has handed over everything that
 * credential authorizes. Attenuation is the alternative: derive a **narrower** grant for the next
 * hop — fewer scopes, less budget, never longer-lived — and hand *that* down.
 *
 * A derivation may only ever narrow. Four dimensions, all one-way:
 *
 * | Dimension | The child may | Because |
 * |---|---|---|
 * | `verb` | keep the parent's | a `subscribe` grant is not an `invoke` grant in disguise |
 * | `scope` | keep it, or take one the parent covers | `world/*` → `world/x`, never the reverse |
 * | `budget_units` | keep it, or take less | this is the §5 rule, spelled directly |
 * | `expires_at` | end when the parent does, or sooner | a child outliving its parent re-mints authority the parent already lost |
 *
 * The ceiling case carries the same rule the mint gate has: **an unstated child ceiling is not a
 * request for an unbounded one.** An absent `budget_units` means unbounded everywhere in this
 * package, so under a bounded parent the child *inherits* the parent's — the caller who said
 * nothing gets exactly what it held, which is the only reading that cannot widen. Explicitly
 * asking for more is a different act, and is refused.
 *
 * Refusals are **403**: a derivation request is readable, it simply asks for authority the
 * presented parent does not carry.
 */
import {
  CEILING_KEY,
  GrantError,
  grantToken,
  scopeCovers,
  type Grant,
  type IssuedGrant,
} from './grant.ts';
import { instant } from './keys.ts';

/**
 * Narrow `parent` to `child`, or refuse. Returns the child grant with whatever the parent
 * constrains filled in — today, the inherited ceiling.
 *
 * The parent is a plain {@link Grant} on purpose: the *authenticity* of a presented parent is
 * `verify.ts`'s question and is answered before this is ever called. This function answers only
 * "does what that grant says cover what is being asked for", which is the same question
 * `apr_grant:permits/3` answers at a relying party's door — with the ceiling comparison §5 adds.
 */
export function attenuate(parent: Grant, child: Grant): Grant {
  if (child.verb !== parent.verb) {
    throw new GrantError(
      403,
      `${grantToken(parent)} cannot derive ${grantToken(child)}: a derived grant keeps the parent's verb`,
    );
  }
  if (!scopeCovers(parent.scope, child.scope)) {
    throw new GrantError(
      403,
      `${grantToken(parent)} does not cover ${grantToken(child)}: a derived scope may only narrow`,
    );
  }
  return { ...child, budget_units: narrowedCeiling(parent.budget_units, child.budget_units) };
}

/**
 * The ceiling a child may carry under a parent's, or a refusal.
 *
 * An unbounded parent constrains nothing, so the child's request stands as asked — including an
 * unbounded one, which is not a widening because there was nothing to widen. Under a bounded
 * parent, an unstated child ceiling inherits rather than becoming unbounded.
 */
export function narrowedCeiling(
  parent: number | undefined,
  child: number | undefined,
): number | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  if (child > parent) {
    throw new GrantError(
      403,
      `a derived grant may not raise ${CEILING_KEY} from ${parent} to ${child}`,
    );
  }
  return child;
}

/**
 * When a child derived at `at` for `lifetimeMs` must stop counting: its own lifetime, or its
 * parent's expiry, whichever comes first.
 *
 * A grant that outlived the one it was derived from would let a holder mint its own extension —
 * present a grant in its last second, walk away with a fresh hour — which is the chain escaping
 * its authorization along the one axis nobody thinks to check.
 */
export function derivedExpiry(parent: IssuedGrant, at: string, lifetimeMs: number): string {
  const own = instant(at) + lifetimeMs;
  const parentEnds = instant(parent.expires_at);
  if (parentEnds <= instant(at)) {
    // Unreachable through the issuer (verification refuses an expired parent first), but a
    // caller of this function directly must not get a child that was born expired.
    throw new GrantError(403, `the parent grant expired at ${parent.expires_at}`);
  }
  return new Date(Math.min(own, parentEnds)).toISOString();
}
