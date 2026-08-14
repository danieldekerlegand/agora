#!/usr/bin/env node
/**
 * The drift gate over agora's koine pins — the check that compares them to **koine**, not to
 * themselves.
 *
 * ## The hole this closes
 *
 * The spec versions this build implements are pinned in FOUR languages (see
 * `../versions.ts`), and three gates already assert those four constants agree:
 * `provider-router/tests/test_skeleton.py`, `trainer/tests/test_skeleton.py` and
 * `apr_conformance_SUITE`. Every one of them compares agora to ITSELF. So the failure they catch
 * is a half-applied bump — and the failure they cannot catch is the one that actually happened
 * (agora:70): all four constants agreeing on a version koine left behind. A stale pin table stays
 * green while asserting the wrong thing, which for a runtime commons whose premise is "koine
 * specifies, agora implements" is the most damaging bug class available.
 *
 * This module reads the `**Spec version:**` header out of koine's own spec files and fails when
 * any pin disagrees. It is the same vendor-with-drift-gate pattern the interchange schemas already
 * use (`scripts/regen-koine-schemas.mjs --check` + `../koine-schema-drift.test.ts`): the pin table
 * is a hand-maintained mirror of koine data, so something has to fail when the mirror rots.
 *
 * ## What it does NOT do
 *
 * There is no `--write` mode, deliberately. Advancing a pin is never a one-file edit: it moves four
 * languages plus every fixture that stamps the version, and — under the track-current policy in
 * `versions.ts` — it is a claim that this build implements the new text. A generator that rewrote
 * the table would manufacture that claim. The gate reports; a human repins.
 *
 * ## Modes
 *
 * - **ENFORCED** — a koine sibling checkout was found; every pin is compared to its header.
 * - **SKIPPED** — no koine checkout is reachable (CI, a fresh clone, a container). The gate says so
 *   loudly and exits 0: a build with no way to satisfy the check must not be failed by it, and must
 *   not be told it passed either. Which mode ran is always the first line of output.
 *
 * Runnable as a CLI (exit 0 = in sync or skipped, 1 = drift, 2 = usage):
 *
 *   node schemas/src/conformance/koine-pin-drift.ts [--specs <dir>]
 *
 * Wired as `npm run -w @agora/schemas check:koine-pins` and as the `check-koine-pins` make target,
 * a prerequisite of `check-schemas` and a step of `check`. The vitest beside this file
 * (`koine-pin-drift.test.ts`) runs the same comparison inside the schemas gate, so a koine bump
 * surfaces on the next `make check` rather than at the next audit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SPEC_VERSIONS } from '../versions.ts';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/src/conformance

/** A row of the pin table — the specs `SPEC_VERSIONS` pins, by koine's short name. */
export type SpecKey = keyof typeof SPEC_VERSIONS;

/**
 * Which koine spec file states each pinned row's version. `satisfies` is load-bearing: a seventh
 * pin added to {@link SPEC_VERSIONS} without a file here fails the typecheck rather than quietly
 * going ungated — the same "a new row is a decision, not an oversight" rule as the per-row register
 * in `versions.ts`.
 */
export const KOINE_SPEC_FILES = {
  kcb: 'capability-bus.md',
  kinp: 'identity.md',
  kgp: 'grounding-pack.md',
  kmi: 'media-interchange.md',
  kft: 'fine-tuning.md',
  kcs: 'conformance-scenario.md',
} as const satisfies Record<SpecKey, string>;

/** The pinned specs, in the order `SPEC_VERSIONS` declares them. */
export const SPEC_KEYS = Object.keys(KOINE_SPEC_FILES) as SpecKey[];

/** One pin that disagrees with koine, or that koine could not be read for. */
export interface PinDrift {
  spec: SpecKey;
  /** What `SPEC_VERSIONS` says. */
  pinned: string;
  /** What koine's header says — null when the file or its header could not be read. */
  koine: string | null;
  /** koine-relative path of the spec that states the truth. */
  specFile: string;
  /** The failure, naming the spec, both versions, and the file to edit. */
  message: string;
}

/**
 * The version in a koine spec's header — line 3 of every spec, `**Spec version:** X.Y.Z`.
 * Returns null when the document carries no such header, which is itself reportable drift (koine
 * moved the header, or the file is not a spec).
 */
export function parseSpecVersion(markdown: string): string | null {
  return /^\*\*Spec version:\*\*[ \t]+(\S+)[ \t]*$/m.exec(markdown)?.[1] ?? null;
}

/**
 * koine's canonical `specs/` directory — the source of truth for every pin. koine is a SIBLING of
 * the agora working tree (`../koine`, ADR-0001), resolved against this tree's own root AND the
 * PRIMARY working tree (via git's common dir) so a git worktree — whose own `../koine` does not
 * exist — still finds the one checkout that does. Mirrors `findKoineSchemasDir` in
 * `scripts/regen-koine-schemas.mjs` and `koineSchemasDir` in `version-drift.test.ts`.
 *
 * Returns null rather than throwing: unlike those two, an absent koine here is a loud SKIP, not a
 * failure (see the module comment).
 */
export function findKoineSpecsDir(): string | null {
  const roots = [resolve(HERE, '..', '..', '..')]; // this working tree's repo root
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) roots.push(dirname(commonDir)); // the primary working tree's root
  } catch {
    // git unavailable — the relative candidate above is the only one we can try.
  }
  for (const root of roots) {
    const dir = join(dirname(root), 'koine', 'specs');
    if (existsSync(join(dir, KOINE_SPEC_FILES.kcb))) return dir;
  }
  return null;
}

/** Every pinned spec's version as koine states it — null for one that could not be read. */
export function readKoineSpecVersions(specsDir: string): Record<SpecKey, string | null> {
  const versions = {} as Record<SpecKey, string | null>;
  for (const spec of SPEC_KEYS) {
    const path = join(specsDir, KOINE_SPEC_FILES[spec]);
    versions[spec] = existsSync(path) ? parseSpecVersion(readFileSync(path, 'utf8')) : null;
  }
  return versions;
}

/**
 * The pins that disagree with koine. Pure over both sides — the comparison is separable from
 * reading koine so the gate can be tested red as well as green (`koine-pin-drift.test.ts`).
 */
export function specPinDrift(
  koineVersions: Partial<Record<SpecKey, string | null>>,
  pins: Record<SpecKey, string> = SPEC_VERSIONS,
): PinDrift[] {
  const drift: PinDrift[] = [];
  for (const spec of SPEC_KEYS) {
    const pinned = pins[spec];
    const koine = koineVersions[spec] ?? null;
    if (koine === pinned) continue;
    const specFile = `koine/specs/${KOINE_SPEC_FILES[spec]}`;
    const stated =
      koine === null
        ? `${specFile} states no readable \`**Spec version:**\` header`
        : `${specFile} states ${koine}`;
    drift.push({
      spec,
      pinned,
      koine,
      specFile,
      message:
        `${spec}: agora pins ${pinned}, ${stated} — repin SPEC_VERSIONS.${spec} in ` +
        `schemas/src/versions.ts, in lockstep with the Python/Erlang/Rust constants and every ` +
        `fixture that stamps it (see that file's doc comment), or record the deliberate lag in ` +
        `its per-row register entry`,
    });
  }
  return drift;
}

/** The notice the SKIPPED mode prints — explicit about what was NOT checked, and how to check it. */
export const SKIP_NOTICE: string = [
  '='.repeat(78),
  'koine pin drift gate: SKIPPED — no koine sibling checkout found.',
  "  agora's pins (schemas/src/versions.ts) were NOT compared to koine's spec headers, so this",
  '  run proves nothing about them. It is not a failure either: a checkout with no koine beside',
  '  it has no way to satisfy the check (ADR-0001 makes koine a sibling, not a dependency).',
  '  To enforce it: clone koine next to agora (../koine) and re-run `make check-schemas`.',
  '='.repeat(78),
].join('\n');

/**
 * The CLI. Returns the exit code rather than calling `process.exit`, so a test can assert it —
 * the convention `validate.ts` established. `resolveSpecsDir` is injectable for the same reason:
 * the SKIPPED path must be provable on a host that DOES have koine, or the branch that must never
 * silently pass would itself never be exercised.
 */
export function main(
  argv: string[],
  resolveSpecsDir: () => string | null = findKoineSpecsDir,
): number {
  const args = argv.slice(2);
  let specsDir: string | null;
  if (args[0] === '--specs') {
    // An explicit koine checkout, for a non-standard layout and for this gate's own tests.
    specsDir = args[1] ?? null;
    if (args.length !== 2 || specsDir === null) {
      console.error('usage: node schemas/src/conformance/koine-pin-drift.ts [--specs <dir>]');
      return 2;
    }
    if (!existsSync(specsDir)) {
      console.error(`--specs ${specsDir}: no such directory`);
      return 2;
    }
  } else if (args.length > 0) {
    console.error('usage: node schemas/src/conformance/koine-pin-drift.ts [--specs <dir>]');
    return 2;
  } else {
    specsDir = resolveSpecsDir();
  }

  if (specsDir === null) {
    console.error(SKIP_NOTICE);
    return 0;
  }

  const drift = specPinDrift(readKoineSpecVersions(specsDir));
  if (drift.length > 0) {
    console.error(
      `koine pin drift gate: ENFORCED (${specsDir}) — ${drift.length} of ${SPEC_KEYS.length} ` +
        `pins disagree with koine:\n  ${drift.map((d) => d.message).join('\n  ')}`,
    );
    return 1;
  }
  console.log(
    `koine pin drift gate: ENFORCED (${specsDir}) — all ${SPEC_KEYS.length} pins match koine.`,
  );
  return 0;
}

// When run directly (`node src/conformance/koine-pin-drift.ts`), exit with the CLI's code; when
// imported, do nothing but export the pieces. Same ESM main-module idiom as `validate.ts`.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  process.exit(main(process.argv));
}
