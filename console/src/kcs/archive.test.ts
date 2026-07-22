/**
 * The archive, exercised against real reports rather than hand-built ones.
 *
 * A content address is only worth anything if it is taken over what a *run* actually
 * produced, so every report here comes out of the production runner driving
 * `kcs:worlds-to-fabric` over its stand-ins. Hand-writing a `ConformanceReport` literal
 * would test the projection against itself.
 */
import { createRegistry } from '@agora/registry';
import type { Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { bundledFixtures, WORLDS_TO_FABRIC_PINAKES } from '../fixtures/standins.ts';
import { WORLDS_TO_FABRIC } from '../scenarios/worlds-to-fabric.ts';
import { archiveReport, reportId, serializeArchive, verifyArchive } from './archive.ts';
import type { ConformanceReport } from './outcome.ts';
import { runScenario } from './runner.ts';

type Injury = (document: Json) => void;

/** One run, with an injectable clock so "the same run twice" can differ only in timing. */
async function run(
  options: { at?: string; injury?: Injury } = {},
): Promise<ConformanceReport> {
  const bundled = bundledFixtures();
  let tick = 0;
  return await runScenario(WORLDS_TO_FABRIC, {
    registry: createRegistry(),
    fixtures: async (path: string): Promise<Json> => {
      const document = JSON.parse(JSON.stringify(await bundled(path))) as Json;
      if (path === WORLDS_TO_FABRIC_PINAKES) options.injury?.(document);
      return document;
    },
    now: () => options.at ?? '2026-07-22T00:00:00.000Z',
    clock: () => (tick += 1),
  });
}

describe('the report is content-addressable (KCS §4.4)', () => {
  it('mints a sha256 address in the same shape as every other id in the commons', async () => {
    expect(await reportId(await run())).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('addresses two runs of the same scenario identically, whatever the clock said', async () => {
    // The property worth having: a re-run that observed the same fabric is the same
    // evidence, so an archive dedups — and an id that *moved* is itself the finding.
    const first = await run({ at: '2026-07-22T00:00:00.000Z' });
    const second = await run({ at: '2027-01-01T09:30:00.000Z' });
    expect(first.observations[0]?.at).not.toBe(second.observations[0]?.at);
    expect(await reportId(second)).toBe(await reportId(first));
  });

  it('moves the address when the fabric answered differently', async () => {
    // Delta C's injury: Pinakes reconciles the fiction entity into `same_as` instead of
    // `based_on`. Same scenario, same participants, red run — and a different address.
    const green = await run();
    const red = await run({
      injury: (document) => {
        at(document, 'invoke', 'resolve.reconcile', 'body', 'links', '0').relation = 'same_as';
      },
    });
    expect(red.green).toBe(false);
    expect(await reportId(red)).not.toBe(await reportId(green));
  });
});

describe('an archive', () => {
  it('carries the address, the verdict and the report itself', async () => {
    const archive = await archiveReport(await run(), { now: () => '2026-07-22T12:00:00.000Z' });
    expect(archive).toMatchObject({
      scenario: 'kcs:worlds-to-fabric',
      green: true,
      stubbed: true,
      archived_at: '2026-07-22T12:00:00.000Z',
    });
    expect(archive.report.assertions.length).toBeGreaterThan(0);
  });

  it('survives a round trip through bytes', async () => {
    const archive = await archiveReport(await run());
    const restored = JSON.parse(serializeArchive(archive)) as typeof archive;
    expect(restored.report_id).toBe(archive.report_id);
    expect(await verifyArchive(restored)).toBe(true);
  });

  it('serialises the same archive to the same bytes', async () => {
    const archive = await archiveReport(await run(), { now: () => '2026-07-22T12:00:00.000Z' });
    expect(serializeArchive(archive)).toBe(serializeArchive(structuredClone(archive)));
  });

  it('fails verification when the archived verdict was edited afterwards', async () => {
    // What content-addressing is *for*: an archive that can be challenged. Flip the verdict
    // in the file and the file no longer answers to its own name.
    const archive = await archiveReport(await run());
    expect(await verifyArchive({ ...archive, report: { ...archive.report, green: false } })).toBe(
      false,
    );
  });

  it('is not disturbed by how long the run took', async () => {
    // `durationMs` is metadata about the run, not evidence — the same split KGP §3.1 makes
    // when it excludes confidence and valid_time from a claim's hash.
    const archive = await archiveReport(await run());
    const slower = { ...archive.report, durationMs: archive.report.durationMs + 1_000 };
    expect(await verifyArchive({ ...archive, report: slower })).toBe(true);
  });
});

function at(document: Json, ...path: string[]): Record<string, Json> {
  let current: unknown = document;
  for (const key of path) {
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) throw new Error(`no ${key} in the fixture at ${path.join('.')}`);
  }
  return current as Record<string, Json>;
}
