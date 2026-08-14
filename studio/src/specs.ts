/**
 * The spec reading — which koine contracts a participant advertises, and in which documents.
 *
 * A participant on this fabric says what it is by publishing: an A2A AgentCard at its own
 * well-known address, carrying the KCB capability manifest as one named extension (KCB §2),
 * and the registry indexes that manifest verbatim (§3). This module is the projection of
 * those documents into something a view can list. It is a *reading*, never a ruling.
 *
 * Three rules hold it down, and they are the whole file:
 *
 * 1. **Nothing is specified here.** The contracts live in koine and their shapes live in
 *    `@agora/schemas` — the plane→contract typing is `PLANE_SPECS` (KCB §2.1), the extension
 *    URI is `KCB_MANIFEST_EXTENSION_URI`, an identity is a KINP id because `parseKinpId` says
 *    so, and the versions this build speaks are `SPEC_VERSIONS`. Not one of those facts is
 *    restated in this file; every one of them is imported. A contract copy in here would be a
 *    second opinion on koine, which is exactly what this tree exists not to hold.
 * 2. **Every claim names where it was read.** An advertisement carries the path in the
 *    participant's own document that produced it ({@link SpecAdvertisement.evidence}), so
 *    "this participant speaks KMI" is a citation rather than an assertion. A contract nothing
 *    in the documents mentions is simply not on the list — the viewer never fills a gap in.
 * 3. **The documents arrive; they are never fetched.** Studio opens no transport (ADR-0001
 *    decisions 3 and 7). The indexed manifest rides in on the discovery answer
 *    (`TopologyNode.advertised`) and a served AgentCard is handed in by the host that read it.
 *    A participant nobody handed a document for advertises nothing here — which is a state,
 *    not a failure, and the same empty view a fresh install draws.
 *
 * What a *declared* version means is likewise not decided here: the reading pairs the version
 * the participant declared with the one this build pins, and leaves them side by side.
 */
import {
  isPlane,
  KCB_MANIFEST_EXTENSION_URI,
  PLANE_SPECS,
  parseKinpId,
  SPEC_VERSIONS,
} from '@agora/schemas';

import type { TopologyNode } from './topology.ts';

/** The koine contracts a participant can advertise, in the order the viewer lists them. */
export const SPEC_NAMES = ['kinp', 'kgp', 'kcb', 'kmi', 'kcs', 'kft'] as const;

export type SpecName = (typeof SPEC_NAMES)[number];

/** The versions this build pins, by contract — every {@link SpecName} the viewer lists. */
const PINNED: Partial<Record<SpecName, string>> = SPEC_VERSIONS;

/**
 * One contract a participant advertises, and what its own documents said about it.
 *
 * `declared` is the version the participant stamped (`<spec>_version`, the key convention the
 * schemas package's own CLI reads); `pinned` is what this build speaks. Either can be absent:
 * a participant may advertise a contract without versioning its mention of it, and a contract
 * this build pins no version for shows an honest blank rather than a zero.
 */
export interface SpecAdvertisement {
  spec: SpecName;
  /** The version the participant declared, when one of its documents carried one. */
  declared?: string;
  /** The version this build pins for that contract (`SPEC_VERSIONS`), when it pins one. */
  pinned?: string;
  /** Where each claim was read — paths into the participant's own documents. */
  evidence: string[];
}

/** What kind of document an artifact is. Both are the participant's, never Studio's. */
export type ArtifactKind = 'agent-card' | 'kcb-manifest';

/**
 * Where a document came from: `served` — the card the host read from the participant itself,
 * and whatever rode inside it; `indexed` — the copy the KCB registry answered with. Kept
 * apart because the provider is authoritative and the index is a cache (§3), so the two
 * disagreeing is a fact worth seeing rather than one to merge away.
 */
export type ArtifactSource = 'served' | 'indexed';

/** One advertised document, verbatim. */
export interface SpecArtifact {
  kind: ArtifactKind;
  source: ArtifactSource;
  /** Where it was read from, as a path a reader can check the claim against. */
  at: string;
  /** The document itself. Carried, never rebuilt: an artifact is the participant's bytes. */
  document: unknown;
}

/** The documents Studio was handed for one participant. Unvalidated, exactly as they arrived. */
export interface Advertisement {
  identity: string;
  /** The A2A AgentCard the host read at the participant's own address, when it read one. */
  card?: unknown;
  /** The KCB manifest body as discovery indexed it (`TopologyNode.advertised`). */
  manifest?: unknown;
}

/** Everything the viewer shows for one participant: what it claims, and what it claimed it in. */
export interface SpecView {
  identity: string;
  contracts: SpecAdvertisement[];
  artifacts: SpecArtifact[];
}

/**
 * What Studio was handed about one participant: whatever discovery indexed, plus the card the
 * host read if it read one. Both optional — a participant that was only ever observed has
 * neither, and says so by advertising nothing.
 */
export function advertisementOf(node: TopologyNode, card?: unknown): Advertisement {
  const advertisement: Advertisement = { identity: node.identity };
  if (card !== undefined) advertisement.card = card;
  if (node.advertised !== undefined) advertisement.manifest = node.advertised;
  return advertisement;
}

/** True when nothing was advertised — the empty spec view, the same state as an empty stage. */
export function isEmptyView(view: SpecView): boolean {
  return view.contracts.length === 0 && view.artifacts.length === 0;
}

/** The version this build speaks for a contract, or nothing where it pins none. */
export function pinnedVersion(spec: SpecName): string | undefined {
  return PINNED[spec];
}

/**
 * Read one participant's advertised documents: which contracts they mention, and where.
 *
 * Every artifact handed in is listed, readable or not — a card that turns out to be nonsense
 * was still advertised, and hiding it would hide the only evidence of the problem. Only the
 * *claims* are guarded: a document that is not an object contributes no contracts, because
 * there is nothing in it to cite.
 */
export function specViewOf(advertisement?: Advertisement | null): SpecView {
  const identity = advertisement?.identity ?? '';
  const view: SpecView = { identity, contracts: [], artifacts: [] };
  if (!advertisement) return view;

  const claims = new Map<SpecName, SpecAdvertisement>();
  const note = (spec: SpecName, at: string, declared?: string): void => {
    const claim = claims.get(spec) ?? { spec, evidence: [] };
    if (!claim.evidence.includes(at)) claim.evidence.push(at);
    if (declared !== undefined && claim.declared === undefined) claim.declared = declared;
    claims.set(spec, claim);
  };

  if (advertisement.card !== undefined) {
    const at = 'agent_card';
    view.artifacts.push({ kind: 'agent-card', source: 'served', at, document: advertisement.card });

    const card = record(advertisement.card);
    if (card) {
      declaredVersions(card, at, note);
      const extension = kcbExtension(card);
      if (extension) {
        note('kcb', `${at}.capabilities.extensions[${extension.index}].uri`);
        const params = `${at}.capabilities.extensions[${extension.index}].params`;
        // An extension carrying no params is not a second document — it is a malformed card,
        // and the card is already on the list to say so.
        if (extension.params !== undefined) {
          view.artifacts.push({
            kind: 'kcb-manifest',
            source: 'served',
            at: params,
            document: extension.params,
          });
        }
        readManifest(extension.params, params, note);
      }
    }
  }

  if (advertisement.manifest !== undefined) {
    const at = 'manifest';
    view.artifacts.push({
      kind: 'kcb-manifest',
      source: 'indexed',
      at,
      document: advertisement.manifest,
    });
    readManifest(advertisement.manifest, at, note);
  }

  // Listed in the fixed contract order rather than in discovery order, so two participants'
  // readings are comparable at a glance; a contract nobody mentioned is absent, not blank.
  for (const spec of SPEC_NAMES) {
    const claim = claims.get(spec);
    if (!claim) continue;
    const pinned = pinnedVersion(spec);
    view.contracts.push(pinned === undefined ? claim : { ...claim, pinned });
  }
  return view;
}

/** What one KCB manifest body mentions: its own version, its identity, its ports, its methods. */
function readManifest(
  value: unknown,
  at: string,
  note: (spec: SpecName, at: string, declared?: string) => void,
): void {
  const manifest = record(value);
  if (!manifest) return;

  declaredVersions(manifest, at, note);
  // The identity is a KINP claim in itself: the compact three-segment id is the naming
  // contract's own shape (KINP §3.2), and `parseKinpId` is what decides that, not this file.
  if (parseKinpId(manifest.identity) !== undefined) note('kinp', `${at}.identity`);

  for (const direction of ['produces', 'consumes'] as const) {
    ports(manifest[direction], `${at}.${direction}`, note);
  }

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  capabilities.forEach((entry, index) => {
    const capability = record(entry);
    if (!capability) return;
    const path = `${at}.capabilities[${index}]`;
    ports(capability.inputs, `${path}.inputs`, note);
    ports(capability.outputs, `${path}.outputs`, note);
    // `modality` and `methods` are KFT §3.1 refinements the manifest schema carries through
    // untouched (`schemas/src/manifest.ts`) — a capability that states either is telling the
    // finetune registry it serves KFT work, which is the advertisement being read here.
    if (typeof capability.modality === 'string') note('kft', `${path}.modality`);
    if (Array.isArray(capability.methods)) note('kft', `${path}.methods`);
  });
}

/** Which contract each port's plane types (KCB §2.1) — the schemas package's own mapping. */
function ports(
  value: unknown,
  at: string,
  note: (spec: SpecName, at: string, declared?: string) => void,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const port = record(entry);
    if (!port || !isPlane(port.plane)) return;
    note(PLANE_SPECS[port.plane], `${at}[${index}].plane`);
  });
}

/**
 * The versions a document stamps on itself.
 *
 * `<spec>_version` is koine's own key convention — the KCB manifest carries `kcb_version`, a
 * grounding pack `kgp_version`, a finetune job `kft_version` (`schemas/src/validate.ts` reads
 * exactly these). Reading the same key for every contract adds no rule of Studio's: a document
 * that stamps one is advertising that contract, and one that does not is not.
 */
function declaredVersions(
  document: Record<string, unknown>,
  at: string,
  note: (spec: SpecName, at: string, declared?: string) => void,
): void {
  for (const spec of SPEC_NAMES) {
    const key = `${spec}_version`;
    const declared = document[key];
    if (typeof declared === 'string' && declared !== '') note(spec, `${at}.${key}`, declared);
  }
}

/** The single KCB manifest extension on a card, if it carries one — located by its URI. */
function kcbExtension(card: Record<string, unknown>): { index: number; params: unknown } | undefined {
  const capabilities = record(card.capabilities);
  const extensions = capabilities && Array.isArray(capabilities.extensions)
    ? capabilities.extensions
    : [];
  for (const [index, entry] of extensions.entries()) {
    const extension = record(entry);
    if (extension?.uri === KCB_MANIFEST_EXTENSION_URI) return { index, params: extension.params };
  }
  return undefined;
}

/** A document as an object, or nothing — the guard every structural read starts with. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
