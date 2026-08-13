import { describe, expect, it } from 'vitest';

import { GrantError, parseGrant, type Grant, type IssuedGrant } from './grant.ts';
import { createGrantIssuer } from './issuer.ts';
import { createSigningKey } from './keys.ts';
import {
  applyCeilingPolicy,
  capFor,
  parseCeilingPolicy,
  scopesIntersect,
  UNCAPPED_POLICY,
  type CeilingPolicy,
} from './policy.ts';

const GRANTEE = 'example:agent:some-principal';

function grant(scope: string, budget_units?: number): Grant {
  return parseGrant({ scope, ...(budget_units === undefined ? {} : { budget_units }) });
}

function clamping(caps: CeilingPolicy['caps']): CeilingPolicy {
  return { mode: 'clamp', caps };
}

function refusing(caps: CeilingPolicy['caps']): CeilingPolicy {
  return { mode: 'refuse', caps };
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof GrantError ? err.status : -1;
  }
}

describe('which cap binds', () => {
  const policy = clamping([
    { scope: '*', max_units: 1000 },
    { scope: 'world/*', max_units: 100 },
    { scope: 'finetune', verb: 'invoke', max_units: 50 },
  ]);

  it('binds the tightest cap that reaches the scope, whatever order they are written in', () => {
    expect(capFor(policy, 'invoke', 'finetune')?.max_units).toBe(50);
    expect(capFor(policy, 'subscribe', 'world/consensus-reality')?.max_units).toBe(100);
    expect(capFor(policy, 'fetch', 'asset')?.max_units).toBe(1000);
  });

  it('binds a cap the grant could be spent against, not only one that covers it', () => {
    // A grant on `world/*` is spendable on `world/consensus-reality`, so the cap on that world
    // has to bind it — coverage in one direction only would let a wildcard walk past every
    // narrow cap the operator wrote.
    expect(scopesIntersect('world/consensus-reality', 'world/*')).toBe(true);
    const narrow = clamping([{ scope: 'world/consensus-reality', max_units: 5 }]);
    expect(capFor(narrow, 'subscribe', 'world/*')?.max_units).toBe(5);
  });

  it('ignores a cap bound to a different verb', () => {
    expect(capFor(policy, 'subscribe', 'finetune')?.max_units).toBe(1000);
  });

  it('binds nothing when the policy declares no caps', () => {
    expect(capFor(UNCAPPED_POLICY, 'invoke', 'finetune')).toBeUndefined();
    expect(applyCeilingPolicy(UNCAPPED_POLICY, grant('invoke:finetune'))).toEqual(
      grant('invoke:finetune'),
    );
  });
});

describe('applying the policy', () => {
  const caps = [{ scope: 'finetune', max_units: 50 }];

  it('leaves a request under the cap exactly as asked', () => {
    expect(applyCeilingPolicy(clamping(caps), grant('invoke:finetune', 40)).budget_units).toBe(40);
    expect(applyCeilingPolicy(clamping(caps), grant('invoke:finetune', 50)).budget_units).toBe(50);
  });

  it('clamps an over-cap request to the cap', () => {
    expect(applyCeilingPolicy(clamping(caps), grant('invoke:finetune', 5000)).budget_units).toBe(50);
  });

  it('refuses an over-cap request with a 403 naming the cap, in refuse mode', () => {
    const refusal = (): unknown => applyCeilingPolicy(refusing(caps), grant('invoke:finetune', 5000));
    expect(statusOf(refusal)).toBe(403);
    expect(refusal).toThrow(/policy caps/);
  });

  it('never mints an unbounded grant where a cap is declared — the unstated ceiling rule', () => {
    // An absent ceiling is unbounded (grant.ts, apr_grant, the trainer), so it asks for MORE
    // than any cap. It is answered exactly as an over-cap number is, never waved through.
    expect(applyCeilingPolicy(clamping(caps), grant('invoke:finetune')).budget_units).toBe(50);
    expect(statusOf(() => applyCeilingPolicy(refusing(caps), grant('invoke:finetune')))).toBe(403);
  });

  it('leaves an unstated ceiling unbounded where no cap reaches the scope', () => {
    expect(applyCeilingPolicy(clamping(caps), grant('fetch:asset')).budget_units).toBeUndefined();
  });
});

describe('reading a policy off configuration', () => {
  it('parses the wire form, verbs and all', () => {
    expect(
      parseCeilingPolicy({
        mode: 'refuse',
        caps: [{ scope: 'world/*', verb: 'subscribe', max_units: '25' }],
      }),
    ).toEqual({ mode: 'refuse', caps: [{ scope: 'world/*', verb: 'subscribe', max_units: 25 }] });
  });

  it('defaults an unstated policy to no caps at all', () => {
    expect(parseCeilingPolicy(undefined)).toEqual(UNCAPPED_POLICY);
    expect(parseCeilingPolicy({})).toEqual(UNCAPPED_POLICY);
  });

  it('refuses a cap that states no ceiling — an absent cap is not a cap', () => {
    expect(statusOf(() => parseCeilingPolicy({ caps: [{ scope: '*' }] }))).toBe(422);
  });

  it('refuses a malformed cap rather than reading it as no cap', () => {
    // The same rule the ceiling itself has: a typo that silently became "unlimited" is how a
    // policy stops being one without anybody noticing.
    expect(statusOf(() => parseCeilingPolicy({ caps: [{ scope: '*', max_units: 'lots' }] }))).toBe(422);
    expect(statusOf(() => parseCeilingPolicy({ mode: 'allow', caps: [] }))).toBe(422);
    expect(statusOf(() => parseCeilingPolicy({ caps: [{ scope: '*', verb: 'publish', max_units: 1 }] }))).toBe(422);
    expect(statusOf(() => parseCeilingPolicy('*:100'))).toBe(422);
  });
});

describe('the issuer applies the policy at mint time', () => {
  const key = createSigningKey('policy-test');
  const caps = [{ scope: 'finetune', verb: 'invoke' as const, max_units: 50 }];

  function issue(issuer: ReturnType<typeof createGrantIssuer>, request: Record<string, unknown>): IssuedGrant {
    return issuer.issue({ grantee: GRANTEE, ...request });
  }

  it('mints an over-cap request clamped, and signs the clamped ceiling', () => {
    const issuer = createGrantIssuer({ key, ceilings: clamping(caps) });
    const minted = issue(issuer, { scope: 'invoke:finetune', budget_units: 5000 });
    expect(minted.budget_units).toBe(50);
    // The signature covers what was minted, not what was asked for: a relying party reading it
    // back gets the clamped ceiling and a signature that agrees with it.
    expect(issuer.verify(JSON.parse(JSON.stringify(minted))).budget_units).toBe(50);
  });

  it('mints an unstated ceiling at the cap rather than unbounded', () => {
    const issuer = createGrantIssuer({ key, ceilings: clamping(caps) });
    expect(issue(issuer, { scope: 'invoke:finetune' }).budget_units).toBe(50);
  });

  it('refuses instead, when the host configured it to', () => {
    const issuer = createGrantIssuer({ key, ceilings: refusing(caps) });
    expect(statusOf(() => issue(issuer, { scope: 'invoke:finetune', budget_units: 5000 }))).toBe(403);
    expect(statusOf(() => issue(issuer, { scope: 'invoke:finetune' }))).toBe(403);
    // Under the cap is still minted, and a scope no cap reaches is untouched.
    expect(issue(issuer, { scope: 'invoke:finetune', budget_units: 10 }).budget_units).toBe(10);
    expect(issue(issuer, { scope: 'fetch:asset' }).budget_units).toBeUndefined();
  });

  it('declares no caps by default — a host that said nothing authorized no limit', () => {
    expect(createGrantIssuer({ key }).ceilings).toEqual(UNCAPPED_POLICY);
  });
});
