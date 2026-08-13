/**
 * The spec ruling — does what a participant advertised actually validate?
 *
 * `specs.ts` reads a participant's documents and lists what they claim; it deliberately rules
 * on none of it. This is the other half: every document that reading listed is handed to
 * `@agora/schemas` — the same narrowing the KCB registry runs at index time — and whatever it
 * says comes back out verbatim, as a verdict with the checker's own reason attached.
 *
 * Three rules hold this file down too:
 *
 * 1. **The ruling is the schemas package's, never Studio's.** A card is checked by
 *    {@link parseManifest} and a manifest body by {@link parseManifestBody} (`schemas/manifest.ts`,
 *    keyed to the extension URI `agent-card.ts` owns), and the version those reject on is the
 *    one `schemas/src/versions.ts` pins — {@link isCompatibleKcbVersion} reads `SPEC_VERSIONS`,
 *    so bumping the pin moves this viewer with it and no constant here needs touching. Not one
 *    field requirement, plane vocabulary or version rule is restated in this file. Re-deriving
 *    any of them here would make Studio a second opinion on koine, which is the one thing an
 *    observer must never become.
 * 2. **A verdict is never invented.** Where the schemas package states no rule — every contract
 *    but KCB has no compatibility function to call — the verdict is {@link UNJUDGED} and says
 *    why, rather than a pass nobody granted or a failure nobody found. `unjudged` is a real
 *    reading of a real fabric; a fabricated `valid` is how a conformance claim gets laundered.
 * 3. **The reason travels with the verdict.** `invalid` alone is an accusation; `invalid`
 *    carrying `manifest.kcb_version 9.9.9 is not readable by KCB <pin>` is a finding the reader
 *    can check against the document printed directly beneath it.
 *
 * The ajv-backed `validate()` (`schemas/src/validate.ts`, `validator.ts`) is not called here:
 * the koine schema snapshot governs the *interchange* artifacts (grounding packs, exports,
 * finetune jobs), and there is no card or capability-manifest schema in it — `manifest.ts` is
 * what validates those, and it is what the registry itself uses. It also reads schemas off
 * disk through `node:fs`, which the browser bundle drops only while nothing imports it.
 */
import {
  isCompatibleKcbVersion,
  parseManifest,
  parseManifestBody,
  SPEC_VERSIONS,
} from '@agora/schemas';

import type { ArtifactKind, ArtifactSource, SpecAdvertisement, SpecArtifact, SpecName, SpecView } from './specs.ts';

/**
 * What a check concluded. `unjudged` is not a soft `valid`: it means no rule existed to apply,
 * and it is reported as loudly as either of the other two.
 */
export type Verdict = 'valid' | 'invalid' | 'unjudged';

/** The verdict for a claim the schemas package states no rule about. */
export const UNJUDGED: Verdict = 'unjudged';

/** What every check answers with: a verdict, who reached it, and why. */
export interface Check {
  verdict: Verdict;
  /** The `@agora/schemas` entry point that ruled, so the reader can go read the rule itself. */
  by: string;
  /** The checker's own words. Empty for a clean pass; never Studio's paraphrase. */
  reasons: string[];
}

/** One advertised document, checked. Carries the artifact's own coordinates so a view can pair them. */
export interface ArtifactCheck extends Check {
  kind: ArtifactKind;
  source: ArtifactSource;
  /** The path the document was read at — the key {@link SpecArtifact} is listed under. */
  at: string;
}

/** One advertised contract, checked: the version declared against the version this build pins. */
export interface ContractCheck extends Check {
  spec: SpecName;
  declared?: string;
  pinned?: string;
}

/** A whole participant's advertisement, ruled on document by document and contract by contract. */
export interface CheckedView {
  identity: string;
  contracts: ContractCheck[];
  artifacts: ArtifactCheck[];
}

/** Check every document and contract in one reading, in the order the reading listed them. */
export function checkView(view: SpecView): CheckedView {
  return {
    identity: view.identity,
    contracts: view.contracts.map(checkContract),
    artifacts: view.artifacts.map(checkArtifact),
  };
}

/**
 * Validate one advertised document with the schemas package.
 *
 * A served AgentCard is checked whole ({@link parseManifest}: the card, its single KCB
 * extension, and the manifest riding in that extension's `params`); a manifest body — the
 * indexed copy, or the one lifted out of a card — is checked on its own
 * ({@link parseManifestBody}). Anything either one throws becomes the reason, unedited.
 */
export function checkArtifact(artifact: SpecArtifact): ArtifactCheck {
  const by = artifact.kind === 'agent-card' ? 'parseManifest' : 'parseManifestBody';
  const parse = artifact.kind === 'agent-card' ? parseManifest : parseManifestBody;
  const base = { kind: artifact.kind, source: artifact.source, at: artifact.at, by };
  try {
    parse(artifact.document);
    return { ...base, verdict: 'valid', reasons: [] };
  } catch (err) {
    return { ...base, verdict: 'invalid', reasons: [reasonOf(err)] };
  }
}

/**
 * Check one advertised contract's version against the version this build pins.
 *
 * KCB is the contract `@agora/schemas` states a compatibility rule for
 * ({@link isCompatibleKcbVersion}: same major, and below 1.0 the same minor), so KCB is the
 * contract with a verdict. For every other one the pinned version is a fact about this build
 * rather than a rule about the participant: the two agreeing is a pass anybody can see, and
 * the two differing is {@link UNJUDGED} — a disagreement worth surfacing, not a failure Studio
 * has any standing to declare. A contract the participant stamped no version on is unjudged
 * for the plainest reason of all: there is nothing to check.
 */
export function checkContract(contract: SpecAdvertisement): ContractCheck {
  const base: ContractCheck = { spec: contract.spec, verdict: UNJUDGED, by: 'SPEC_VERSIONS', reasons: [] };
  if (contract.declared !== undefined) base.declared = contract.declared;
  if (contract.pinned !== undefined) base.pinned = contract.pinned;

  if (contract.declared === undefined) {
    return { ...base, reasons: ['no version declared — nothing to check'] };
  }
  if (contract.spec === 'kcb') {
    const by = 'isCompatibleKcbVersion';
    return isCompatibleKcbVersion(contract.declared)
      ? { ...base, verdict: 'valid', by, reasons: [] }
      : {
          ...base,
          verdict: 'invalid',
          by,
          reasons: [`${contract.declared} is not readable by KCB ${SPEC_VERSIONS.kcb}`],
        };
  }
  if (contract.pinned === undefined) {
    return { ...base, reasons: [`this build pins no ${contract.spec} version to check against`] };
  }
  if (contract.pinned === contract.declared) return { ...base, verdict: 'valid' };
  return {
    ...base,
    reasons: [
      `declared ${contract.declared}, this build pins ${contract.pinned} — ` +
        `@agora/schemas states no ${contract.spec} compatibility rule to judge the difference by`,
    ],
  };
}

/** A thrown value as the reason it is. Whatever the checker said, however it said it. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
