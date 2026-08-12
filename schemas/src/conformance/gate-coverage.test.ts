/**
 * US-3 (agora:41) — the gate covers exactly what the validators claim to validate.
 *
 * `make check` reaches `finetune-job` through ONE line: the `ARTIFACTS` list that the
 * `check-conformance` target loops over, feeding each name's golden fixture to BOTH validator CLIs
 * (`node schemas/src/validate.ts` and `python -m agora_provider_router.artifact_validator`). That
 * list is a THIRD copy of the artifact set. The TypeScript `ARTIFACT_SCHEMAS` (`validator.ts`) and
 * the Python one (`artifact_validator.py`) are each pinned by their own suite's exact-set
 * assertion — but nothing pinned the Makefile to either. Dropping a name from it (or adding an
 * artifact to both validators and forgetting the loop) narrows the smoke SILENTLY: every gate stays
 * green while that artifact stops being CLI-smoked at all, which is precisely the regression this
 * story's "a regression in the schema or either validator turns the gate red" property depends on.
 *
 * Kept on the TypeScript side only, on purpose: `provider-router/` is standalone by contract (its
 * README: "no repo-root Makefile, no sibling areas"), so the repo-level assertion belongs to this
 * package — which already reaches across the repo for the schema drift pin
 * (`src/koine-schema-drift.test.ts`).
 *
 * Scope note, since this file is where the CI wiring is asserted: the loop is STRUCTURAL admission
 * only. No modality×method (KFT §3.1/FT-F), egress (§4.2) or spend (§7) judgement is made by either
 * CLI — that is provider behavior at invoke. See `schemas/README.md`
 * §"Structural validation only — where semantic admission lives".
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARTIFACT_SCHEMAS } from '../validator.ts';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/src/conformance
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MAKEFILE = readFileSync(join(REPO_ROOT, 'Makefile'), 'utf8');
const FIXTURES_DIR = join(HERE, 'fixtures');

/** The value of a simple `NAME := ...` assignment in the repo-root Makefile. */
function makeVar(name: string): string {
  const value = new RegExp(`^${name}\\s*:=\\s*(.*)$`, 'm').exec(MAKEFILE)?.[1];
  if (value === undefined) throw new Error(`Makefile has no '${name} :=' assignment`);
  return value.trim();
}

/** The prerequisites of a `target: dep dep ...` rule, comment and recipe stripped. */
function makeTargetDeps(target: string): string[] {
  const deps = new RegExp(`^${target}:([^\\n#]*)`, 'm').exec(MAKEFILE)?.[1];
  if (deps === undefined) throw new Error(`Makefile has no '${target}:' rule`);
  return deps.trim().split(/\s+/).filter(Boolean);
}

describe('make check-conformance covers every artifact', () => {
  const artifacts = makeVar('ARTIFACTS').split(/\s+/).filter(Boolean);

  it('smokes exactly the names both validators expose', () => {
    expect([...artifacts].sort()).toEqual(Object.keys(ARTIFACT_SCHEMAS).sort());
  });

  it('includes finetune-job, the KFT §3 job manifest', () => {
    expect(artifacts).toContain('finetune-job');
  });

  it.each(artifacts)('has the golden fixture the loop replays: %s', (name) => {
    expect(existsSync(join(FIXTURES_DIR, `${name}.json`))).toBe(true);
  });

  it('points the loop at this package’s fixtures directory', () => {
    expect(makeVar('FIXTURES')).toBe('$(CURDIR)/schemas/src/conformance/fixtures');
  });
});

describe('make check runs the conformance gate', () => {
  it('lists check-conformance among its prerequisites', () => {
    expect(makeTargetDeps('check')).toContain('check-conformance');
  });
});
