/**
 * The round trip that matters: does what this issuer mints survive the relying parties that
 * already exist in this tree?
 *
 * Two of them enforce grants today, in two other languages:
 *
 *   provider-router-erl/src/apr_grant.erl   `parse/1`, `permits/3`, `ceiling/1`
 *   trainer/src/agora_trainer/grant.py      `Grant.admits/1`
 *
 * Nothing is imported across those boundaries (ADR-0001: shared over the wire, never as source),
 * so this suite does the two things that ARE available. It **reads both files off disk** and
 * fails when the verb set, the ceiling key, the wildcard spellings or the ungated rule drift
 * away from this package — the same trick that keeps `SPEC_VERSIONS` honest across the polyglot
 * split. And it **runs the trainer's real `Grant`** in a Python subprocess over grants this
 * issuer actually minted, so the ceiling is demonstrably read as the same scalar rather than
 * merely spelled the same way.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  admits,
  CEILING_KEY,
  GRANT_VERBS,
  parseGrant,
  permits,
  SUBTREE_SUFFIX,
  WILDCARD_SCOPE,
  type IssuedGrant,
} from './grant.ts';
import { createGrantIssuer } from './issuer.ts';
import { createSigningKey } from './keys.ts';

const APR_GRANT = readRepoFile('provider-router-erl/src/apr_grant.erl');
const TRAINER_GRANT = readRepoFile('trainer/src/agora_trainer/grant.py');
const TRAINER_SRC = fileURLToPath(new URL('../../trainer/src', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const issuer = createGrantIssuer({ key: createSigningKey('conformance') });

/** A grant of each verb, with and without a ceiling, wildcard scopes included. */
const ISSUED: readonly IssuedGrant[] = [
  { scope: 'invoke:finetune', budget_units: 250 },
  { scope: 'invoke:compose' },
  { scope: 'subscribe:world/consensus-reality', budget_units: 0 },
  { scope: 'subscribe:world/*', budget_units: 12.5 },
  { scope: 'fetch:asset' },
  { scope: 'discover:*' },
  { scope: 'describe:*' },
].map((request) => issuer.issue({ grantee: 'example:agent:principal', ...request }));

/**
 * …plus one **derived** grant. A chain hands its next hop an attenuated grant rather than its
 * own credential, so what the next hop presents at some third door is this — carrying a claim
 * (`derived_from`) neither relying party knows about. It has to parse exactly as a freshly
 * minted one does, or attenuation would buy safety at the cost of being spendable.
 */
const DERIVED: IssuedGrant = issuer.derive({
  parent: JSON.parse(JSON.stringify(ISSUED[3])) as unknown,
  grantee: 'example:agent:next-hop',
  scope: 'world/consensus-reality',
  budget_units: 5,
});

const MINTED: readonly IssuedGrant[] = [...ISSUED, DERIVED];

/** The wire form — what a relying party actually receives. */
const ON_THE_WIRE = MINTED.map((grant) => JSON.parse(JSON.stringify(grant)) as unknown);

describe('the router (apr_grant.erl) and this issuer agree on the shape', () => {
  it('mints only verbs the router will parse', () => {
    const defined = APR_GRANT.match(/-define\(VERBS,\s*\[([^\]]*)\]\)/)?.[1] ?? '';
    const routerVerbs = [...defined.matchAll(/<<"([a-z]+)">>/g)].map((m) => m[1]);
    expect(routerVerbs.length).toBeGreaterThan(0);
    expect([...routerVerbs].sort()).toEqual([...GRANT_VERBS].sort());
  });

  it('spells the ceiling key the way the router reads it', () => {
    expect(APR_GRANT).toContain(`<<"${CEILING_KEY}">>`);
  });

  it('spells the wildcard scopes the way the router matches them', () => {
    expect(APR_GRANT).toContain(`scope_matches(<<"${WILDCARD_SCOPE}">>, _Wanted) -> true`);
    expect(APR_GRANT).toContain(`<<"${SUBTREE_SUFFIX}">>`);
  });

  it('mints the object shape the router splits on: "verb" + "scope"', () => {
    // apr_grant:grant_token/1 builds `<verb>:<scope>` from exactly these two keys.
    expect(APR_GRANT).toContain('apr_json:get(<<"scope">>, Object)');
    expect(APR_GRANT).toContain('apr_json:get(<<"verb">>, Object)');
    for (const grant of ON_THE_WIRE) {
      expect(grant).toMatchObject({ verb: expect.any(String), scope: expect.any(String) });
    }
  });

  it('mints grants that parse and permit exactly what was asked for', () => {
    for (const [index, wire] of ON_THE_WIRE.entries()) {
      const minted = MINTED[index];
      const parsed = parseGrant(wire);
      expect(parsed.verb).toBe(minted?.verb);
      expect(parsed.scope).toBe(minted?.scope);
      expect(parsed.budget_units).toBe(minted?.budget_units);
      expect(permits(parsed, parsed.verb, parsed.scope)).toBe(true);
    }
  });

  it('mints subtree coverage the router honors without enumerating worlds', () => {
    const subtree = parseGrant(
      ON_THE_WIRE[3] ?? issuer.issue({ grantee: 'g', scope: 'subscribe:world/*' }),
    );
    expect(permits(subtree, 'subscribe', 'world/consensus-reality')).toBe(true);
    expect(permits(subtree, 'subscribe', 'world/anything-else')).toBe(true);
    expect(permits(subtree, 'subscribe', 'worlds-elsewhere')).toBe(false);
  });
});

describe('the trainer (grant.py) and this issuer agree on the ceiling', () => {
  it('names the same field, denominated as a number-or-none', () => {
    expect(TRAINER_GRANT).toMatch(new RegExp(`${CEILING_KEY}:\\s*float \\| None`));
  });

  it('still treats a missing ceiling as ungated — the rule this issuer must not widen', () => {
    expect(TRAINER_GRANT).toContain(
      'return self.budget_units is None or estimate <= self.budget_units',
    );
  });

  const python = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' });
  const havePython = python.status === 0;

  it.skipIf(!havePython)('accepts every minted ceiling, read by the real Grant', () => {
    // The trainer's grant.py is stdlib-only, so it runs off PYTHONPATH without an install:
    // the issued grants go in as JSON, the admission decisions come back, and they must match
    // what this package's `admits` says about the same numbers.
    const script = [
      'import json, sys',
      'from agora_trainer.grant import Grant',
      'out = []',
      'for g in json.load(sys.stdin):',
      '    grant = Grant(budget_units=g.get("budget_units"))',
      '    out.append([grant.budget_units, grant.admits(10.0), grant.admits(1e9)])',
      'json.dump(out, sys.stdout)',
    ].join('\n');
    const run = spawnSync('python3', ['-c', script], {
      input: JSON.stringify(ON_THE_WIRE),
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: TRAINER_SRC },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const decisions = JSON.parse(run.stdout) as [number | null, boolean, boolean][];
    expect(decisions).toHaveLength(MINTED.length);
    decisions.forEach(([ceiling, admitsTen, admitsHuge], index) => {
      const grant = MINTED[index];
      if (grant === undefined) expect.unreachable('a minted grant went missing');
      // Same scalar, read the same way — null on the wire is the ungated default, not zero.
      expect(ceiling ?? undefined).toBe(grant.budget_units);
      expect(admitsTen).toBe(admits(grant, 10));
      expect(admitsHuge).toBe(admits(grant, 1e9));
    });
  });
});
