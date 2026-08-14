/**
 * The candidate-version policy is prose, and prose goes stale silently — so the one thing a test
 * can hold is that the per-row register covers every pin. A seventh spec added to
 * {@link SPEC_VERSIONS} without a register row is exactly the "is this a decision or an oversight?"
 * hole the policy exists to close.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SPEC_VERSIONS } from './versions.ts';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'versions.ts'), 'utf8');

/** The register row for one spec — `| **KCB** | Candidate | yes | … |`. */
function registerRow(spec: string): string | undefined {
  const pattern = new RegExp(`^ \\* \\| \\*\\*${spec.toUpperCase()}\\*\\* \\|.*$`, 'm');
  return pattern.exec(SOURCE)?.[0];
}

describe('the per-row pin register', () => {
  it('carries a row for every pinned spec', () => {
    for (const spec of Object.keys(SPEC_VERSIONS)) {
      expect(registerRow(spec), `${spec} is pinned but has no row in the register`).toBeDefined();
    }
  });

  it('states koine’s status and whether the row tracks koine, per spec', () => {
    for (const spec of Object.keys(SPEC_VERSIONS)) {
      const row = registerRow(spec) ?? '';
      expect(row, `${spec}: name koine's status (Ratified / Candidate)`).toMatch(
        /\|\s*(Ratified|Candidate)\s*\|/,
      );
      // "no" is a permitted answer — but a row that answers no owes a reason and the condition
      // that ends it, which is the whole point of writing the answer down.
      expect(row, `${spec}: say whether the pin tracks koine's current version`).toMatch(
        /\|\s*(yes|no)\s*\|/,
      );
    }
  });

  it('records the policy that governs the rows, and where the tolerance applies', () => {
    expect(SOURCE).toContain('TRACK-CURRENT');
    // The three enforcement regimes the policy distinguishes — a row's cost to move depends on
    // which one it sits in, so dropping any of them from the prose loses the rule.
    expect(SOURCE).toContain('resolver/src/grounding.ts'); // majors only
    expect(SOURCE).toContain('isCompatibleKcbVersion'); // major and minor, pre-1.0
    expect(SOURCE).toContain('isCompatibleKcsVersion');
    expect(SOURCE).toContain('No predicate at all'); // KINP / KMI / KFT
  });
});
