/**
 * The drift gate itself, inside the schemas gate — plus the proof that it can go red.
 *
 * A gate nobody has watched fail is a gate nobody knows works, and this one is easy to write in a
 * way that passes forever (compare koine to koine; skip on any hiccup). So the suite runs it three
 * ways: against the real koine checkout when there is one, against a fabricated koine whose headers
 * match the pins (green), and against one whose header has moved (red, with the message a reader
 * needs). The skip path is exercised too — it must announce itself, never pass quietly.
 *
 * Note the deliberate difference from `version-drift.test.ts` next door, which THROWS when koine is
 * absent: that suite re-validates fixtures against koine's live schemas and has nothing to assert
 * without them, whereas this one's subject (agora's pin table) is fully present either way. Both
 * behaviours are loud; only one of them can be satisfied by a checkout with no koine beside it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPEC_VERSIONS } from '../versions.ts';
import {
  findKoineSpecsDir,
  KOINE_SPEC_FILES,
  main,
  parseSpecVersion,
  readKoineSpecVersions,
  SKIP_NOTICE,
  SPEC_KEYS,
  specPinDrift,
  type SpecKey,
} from './koine-pin-drift.ts';

const koineSpecsDir = findKoineSpecsDir();
const MODE = koineSpecsDir === null ? 'SKIPPED' : 'ENFORCED';

/** A throwaway koine `specs/` directory whose headers say exactly what the caller asked for. */
function fakeKoineSpecs(versions: Record<SpecKey, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agora-koine-specs-'));
  for (const spec of SPEC_KEYS) {
    writeFileSync(
      join(dir, KOINE_SPEC_FILES[spec]),
      `# Koine ${spec.toUpperCase()}\n\n**Spec version:** ${versions[spec]}\n**Status:** Candidate\n`,
    );
  }
  return dir;
}

/** The pins as koine would state them if agora were exactly current. */
const IN_SYNC: Record<SpecKey, string> = { ...SPEC_VERSIONS };

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Run the CLI with console captured, so the mode line and the failure text can be asserted.
 * `resolveSpecsDir` stands in for the koine lookup — passing `() => null` is how the SKIPPED path
 * gets exercised on a host that does have koine.
 */
function runCli(
  argv: string[],
  resolveSpecsDir?: () => string | null,
): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void err.push(args.join(' ')));
  const code = resolveSpecsDir
    ? main(['node', 'koine-pin-drift.ts', ...argv], resolveSpecsDir)
    : main(['node', 'koine-pin-drift.ts', ...argv]);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe(`agora's koine pins vs koine's own spec headers [${MODE}]`, () => {
  it(`ran in ${MODE} mode, and says so`, () => {
    const { code, out, err } = runCli([]);
    expect(code).toBe(0);
    // Whichever mode this checkout is in, the output names it — a reader of a CI log can tell an
    // enforced pass from a skipped one without knowing anything about the host.
    expect(`${out}\n${err}`).toContain(`koine pin drift gate: ${MODE}`);
  });

  it.runIf(koineSpecsDir !== null)('every pin equals the version in koine’s spec header', () => {
    const koineVersions = readKoineSpecVersions(koineSpecsDir as string);
    // Guard against a vacuous pass: koine must actually have stated a version for every row.
    for (const spec of SPEC_KEYS) {
      expect(koineVersions[spec], `${KOINE_SPEC_FILES[spec]} carries no **Spec version:** header`)
        .toBeTypeOf('string');
    }
    expect(specPinDrift(koineVersions).map((d) => d.message)).toEqual([]);
  });

  it.skipIf(koineSpecsDir !== null)('skips loudly on THIS host, which has no koine', () => {
    const { code, err } = runCli([]);
    expect(code).toBe(0); // never hard-fail a build that cannot satisfy the check...
    expect(err).toBe(SKIP_NOTICE); // ...and never let it read as a pass.
  });
});

describe('with no koine sibling, the gate skips loudly rather than passing', () => {
  // Run unconditionally, with the koine lookup stubbed out: the branch that must never quietly
  // pass is the one a host WITH koine would otherwise never execute, so it is the last branch that
  // should be left to the environment to cover.
  const noKoine = () => null;

  it('exits 0 — a checkout with no way to satisfy the check is not failed by it', () => {
    expect(runCli([], noKoine).code).toBe(0);
  });

  it('says SKIPPED, what went unchecked, and how to enforce it', () => {
    const { err } = runCli([], noKoine);
    expect(err).toBe(SKIP_NOTICE);
    expect(err).toContain('koine pin drift gate: SKIPPED');
    expect(err).toContain('schemas/src/versions.ts');
    expect(err).toContain('clone koine next to agora');
    // Nothing in the notice can be mistaken for the ENFORCED pass line.
    expect(err).not.toContain('pins match koine');
  });

  it('prints the notice on stderr, where a CI log will not fold it away', () => {
    const { out } = runCli([], noKoine);
    expect(out).toBe('');
  });
});

describe('the drift gate can actually go red', () => {
  it('passes when koine’s headers match the pins', () => {
    const { code, out } = runCli(['--specs', fakeKoineSpecs(IN_SYNC)]);
    expect(code).toBe(0);
    expect(out).toContain(`all ${SPEC_KEYS.length} pins match koine`);
  });

  it('fails when koine has moved past a pin, naming spec, both versions and the file to edit', () => {
    const moved = `${SPEC_VERSIONS.kgp}-moved`;
    const { code, err } = runCli(['--specs', fakeKoineSpecs({ ...IN_SYNC, kgp: moved })]);
    expect(code).toBe(1);
    expect(err).toContain('koine pin drift gate: ENFORCED');
    expect(err).toContain(`kgp: agora pins ${SPEC_VERSIONS.kgp}`);
    expect(err).toContain(`koine/specs/${KOINE_SPEC_FILES.kgp} states ${moved}`);
    expect(err).toContain('schemas/src/versions.ts');
    // One report per drifted row, not a blanket "pins are stale".
    expect(err).not.toContain('kcb: agora pins');
  });

  it('reports a spec whose header it cannot read, rather than treating it as agreement', () => {
    const dir = fakeKoineSpecs(IN_SYNC);
    writeFileSync(join(dir, KOINE_SPEC_FILES.kmi), '# Koine KMI\n\nSpec version: 9.9.9\n');
    const drift = specPinDrift(readKoineSpecVersions(dir));
    expect(drift.map((d) => d.spec)).toEqual(['kmi']);
    expect(drift[0]?.message).toContain('no readable `**Spec version:**` header');
  });

  it('reports every drifted row at once', () => {
    const drift = specPinDrift({ ...IN_SYNC, kcb: '9.0.0', kcs: '9.0.0' });
    expect(drift.map((d) => d.spec)).toEqual(['kcb', 'kcs']);
    expect(drift.map((d) => d.koine)).toEqual(['9.0.0', '9.0.0']);
    expect(drift.map((d) => d.pinned)).toEqual([SPEC_VERSIONS.kcb, SPEC_VERSIONS.kcs]);
  });
});

describe('the header reader', () => {
  it('reads line 3 of a koine spec', () => {
    expect(parseSpecVersion('# Koine X\n\n**Spec version:** 1.2.3\n**Status:** Ratified\n')).toBe(
      '1.2.3',
    );
  });

  it('is null when the header is absent or reshaped', () => {
    expect(parseSpecVersion('# Koine X\n\n**Version:** 1.2.3\n')).toBeNull();
    expect(parseSpecVersion('')).toBeNull();
  });

  it('covers every pinned spec — a new pin without a koine file fails here, not silently', () => {
    expect(Object.keys(KOINE_SPEC_FILES).sort()).toEqual(Object.keys(SPEC_VERSIONS).sort());
  });
});

describe('the CLI contract', () => {
  it('rejects an unknown argument with the usage exit code', () => {
    expect(runCli(['--all']).code).toBe(2);
    expect(runCli(['--specs']).code).toBe(2);
  });

  it('rejects a --specs directory that does not exist', () => {
    const { code, err } = runCli(['--specs', join(tmpdir(), 'agora-no-such-koine-specs')]);
    expect(code).toBe(2);
    expect(err).toContain('no such directory');
  });
});
