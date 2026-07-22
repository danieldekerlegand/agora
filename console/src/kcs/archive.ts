/**
 * Archiving a conformance report — KCS §4.4: "The report is itself content-addressable and
 * archivable."
 *
 * Content-addressable buys three things a timestamped file name does not:
 *
 * * **A re-run that observed the same fabric mints the same id.** So an archive dedups, and
 *   an id that *changed* between two runs of the same scenario is itself the finding.
 * * **Tamper-evidence.** {@link verifyArchive} re-derives the address from the archived
 *   report; an archive whose verdict was edited no longer matches its own id.
 * * **Citability.** A red run is quotable as `sha256-…` — one string that fixes the
 *   scenario, the participants, every assertion and the log slice that supports it.
 *
 * ## What the address covers, and what it deliberately does not
 *
 * The same split KGP §3.1 makes for a claim: hash the identity-bearing content, exclude the
 * metadata *about* the run. So the address covers the scenario, how each participant was
 * reached, every step outcome, every assertion verdict, and the observation log — and
 * excludes **wall-clock time and durations** (`durationMs`, each entry's `at`). Two runs of
 * the same scenario against the same fabric are the same evidence; that they took 41ms and
 * 47ms is not a difference in what was observed.
 *
 * That determinism is only ever as strong as the scenario's own (§7 Q2): the log's `detail`
 * summaries are covered, so a scenario that recorded generated text into one would mint a
 * fresh id per run. Assertions read the fabric's plane-typed facts rather than model output
 * for exactly this reason, and a scenario whose report id will not settle is a scenario
 * asserting something non-deterministic.
 */
import { canonicalJson, type Json, type JsonObject } from '@agora/schemas';

import type { ConformanceReport } from './outcome.ts';

/** A report, addressed by its content and ready to be written down. */
export interface ReportArchive {
  /** `sha256-` + lowerhex, per the hash discipline every id in the commons uses (KGP §3.2). */
  report_id: string;
  kcs_version: string;
  scenario: string;
  green: boolean;
  /** True when the run was not all real — carried on the envelope so a shelf of archives
   * can be filtered without opening each report. */
  stubbed: boolean;
  /** When this archive was written. Not part of the address — see the module note. */
  archived_at: string;
  report: ConformanceReport;
}

const HASH_PREFIX = 'sha256-';

/**
 * The evidence the address is taken over: what was run, what was concluded, what was seen.
 *
 * Written as an explicit projection rather than "the report minus a few fields" so that a
 * field added to {@link ConformanceReport} later is *outside* the address until somebody
 * decides it belongs inside. The alternative — a blanket hash — silently changes every id
 * in the archive the first time an unrelated UI field lands on the report.
 */
export function evidenceOf(report: ConformanceReport): Json {
  return {
    scenario: report.scenario,
    title: report.title,
    kcs_version: report.kcsVersion,
    green: report.green,
    stubbed: report.stubbed,
    participants: report.participants.map((participant) => ({
      identity: participant.identity,
      endpoint: participant.endpoint ?? null,
      discovered: participant.discovered,
      stubbed: participant.stubbed,
      note: participant.note ?? null,
    })),
    steps: report.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      status: step.status,
      expected: step.expected,
      refused: step.refused === undefined ? null : { ...step.refused },
      error: step.error ?? null,
      output: step.output ?? null,
    })),
    assertions: report.assertions.map((assertion) => ({
      id: assertion.id,
      predicate: assertion.predicate,
      args: assertion.args,
      ok: assertion.ok,
      pending: assertion.pending,
      detail: assertion.detail,
      // The supporting log slice by `seq` — the entries themselves are covered below, and
      // an assertion's support is *which* of them, not a second copy of each.
      support: assertion.support.map((entry) => entry.seq),
    })),
    observations: report.observations.map((entry) => ({
      seq: entry.seq,
      step: entry.step,
      participant: entry.participant,
      plane: entry.plane ?? null,
      direction: entry.direction,
      entities: entry.entities,
      detail: entry.detail,
    })),
  } satisfies JsonObject;
}

/** The report's content address. Same input bytes, same id, on any machine. */
export async function reportId(report: ConformanceReport): Promise<string> {
  return await digest(canonicalJson(evidenceOf(report)));
}

export interface ArchiveOptions {
  /** Injectable clock, so an archive is reproducible in a test. */
  now?: (() => string) | undefined;
}

/** Address a finished report and wrap it in the envelope that gets written down. */
export async function archiveReport(
  report: ConformanceReport,
  options: ArchiveOptions = {},
): Promise<ReportArchive> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    report_id: await reportId(report),
    kcs_version: report.kcsVersion,
    scenario: report.scenario,
    green: report.green,
    stubbed: report.stubbed,
    archived_at: now(),
    report,
  };
}

/**
 * The archive as bytes — canonical JSON, so writing the same archive twice writes the same
 * file and a diff between two archives is a diff between two runs.
 */
export function serializeArchive(archive: ReportArchive): string {
  return canonicalJson(JSON.parse(JSON.stringify(archive)) as Json);
}

/**
 * Re-derive the address from the archived report and check it still matches.
 *
 * An archive is only worth keeping if it can be challenged: this is the challenge. A report
 * whose verdict, assertion or log slice was edited after the fact answers `false`.
 */
export async function verifyArchive(archive: ReportArchive): Promise<boolean> {
  return (await reportId(archive.report)) === archive.report_id;
}

/** SHA-256 over UTF-8, lowerhex, prefixed — KGP §3.2 rule 7, via WebCrypto. */
async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${HASH_PREFIX}${hex}`;
}
