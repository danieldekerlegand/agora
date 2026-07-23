/**
 * The KCB capability manifest — `koine/specs/capability-bus.md` §2.
 *
 * The manifest is what a provider publishes about itself and what the registry (§3)
 * indexes. Wire keys are `snake_case` exactly as the spec writes them: these objects
 * arrive verbatim from another process (the provider-router publishes it from Python), so
 * renaming them here would make the TypeScript side a translation layer rather than a
 * reader of the contract.
 *
 * Post-0.3.0 the manifest is no longer a standalone document: it rides as the `params` of a
 * single {@link KCB_MANIFEST_EXTENSION_URI} extension on the provider's A2A AgentCard (§2,
 * see `agent-card.ts`). {@link parseManifest} takes the whole card and narrows that extension
 * out of it; {@link parseManifestBody} narrows a bare `params` body on its own.
 *
 * Both validate and *narrow* — they do not rebuild. A provider's manifest is authoritative
 * (§3); anything this version does not model — inside the `params` body or on the surrounding
 * card — must survive being read.
 */
import { KCB_MANIFEST_EXTENSION_URI, type AgentCard, type AgentExtension } from './agent-card.ts';
import { parseKinpId } from './identity.ts';
import { isPlane } from './planes.ts';
import { SPEC_VERSIONS } from './versions.ts';

/**
 * A port: a typed connection point, used by `produces`/`consumes` and by every
 * capability's `inputs`/`outputs`. Its `plane` selects the type vocabulary (§2.1).
 */
export type Port = KnowledgePort | MediaPort | EntityPort;

/** Typed by KGP dialect + an optional payload `shape` and world scoping. */
export interface KnowledgePort {
  plane: 'knowledge';
  shape?: string;
  dialect?: string;
  worlds?: string[];
}

/** Typed by KMI media types, optionally scoped to worlds by pattern (delta J). */
export interface MediaPort {
  plane: 'media';
  media_types: string[];
  world_pattern?: string;
  shape?: string;
}

/** Typed by KINP entity types. */
export interface EntityPort {
  plane: 'entity';
  types: string[];
}

/** What invoking a capability is projected to cost, in KCB budget units (§2.1 delta K). */
export interface CapabilityCost {
  est_units: number;
  /** Which rung of the provider's own ladder that estimate is for, when it has one. */
  tier?: string;
  unit?: string;
  quantity?: number;
  /** Human-readable statement of the request the estimate prices — costs only compare
   * between providers when the basis does. */
  basis?: string;
  /** True when the provider could not price this route. Not the same as free: an
   * unpriced capability must never be preferred over a known-zero-cost one. */
  unpriced?: boolean;
}

/** A named, invocable unit. Its inputs and outputs are ports, so they span planes. */
export interface Capability {
  name: string;
  inputs?: Port[];
  outputs?: Port[];
  cost?: CapabilityCost;
  /** Where this specific capability is invoked, when it differs from the provider's
   * endpoints. The registry hands it back so the caller dials it directly. */
  endpoint?: string;
  provider?: string;
  model?: string;
}

export interface ManifestAuth {
  scheme?: string;
  grants_required?: string[];
  [key: string]: unknown;
}

/** Shared with the KGP pack manifest (§5). */
export interface ManifestSigning {
  key_id: string;
  alg: string;
}

export interface CapabilityManifest {
  kcb_version: string;
  /** KINP identity — a capability provider is itself a fabric entity (§2). */
  identity: string;
  /** Named addresses. `mcp`/`a2a` are the spec's examples; a provider publishes the
   * addresses it actually serves, and only those. */
  endpoints: Record<string, string>;
  version?: string;
  produces?: Port[];
  consumes?: Port[];
  capabilities?: Capability[];
  auth?: ManifestAuth;
  signing?: ManifestSigning;
}

/** Thrown by {@link parseManifest}; the message names the offending path. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * True when a manifest's KCB version can be read by this build.
 *
 * Same major (and, below 1.0, same minor — pre-1.0 minors are breaking by convention),
 * so a provider that has moved on to an incompatible spec is rejected loudly at the index
 * rather than silently mis-indexed.
 */
export function isCompatibleKcbVersion(version: string): boolean {
  const theirs = version.split('.');
  const ours = SPEC_VERSIONS.kcb.split('.');
  if (theirs[0] !== ours[0]) return false;
  return ours[0] !== '0' || theirs[1] === ours[1];
}

/**
 * Validate an A2A AgentCard and narrow the KCB manifest out of its extension in place.
 *
 * Locates the single `capabilities.extensions[]` entry whose `uri` is
 * {@link KCB_MANIFEST_EXTENSION_URI} and validates its `params` as a {@link CapabilityManifest}
 * via {@link parseManifestBody}. The card itself is never rebuilt, so fields this version does
 * not model — on the card or inside the extension `params` — survive (§3). Throws
 * {@link ManifestError} naming the offending path if the extension is missing, duplicated, or
 * carries params that fail validation.
 */
export function parseManifest(value: unknown): CapabilityManifest {
  return parseManifestBody(kcbExtensionParams(value));
}

/** Narrow the KCB extension's `params` out of an AgentCard, or throw naming the path. */
function kcbExtensionParams(value: unknown): Record<string, unknown> {
  const card = object(value, 'agent_card');
  const capabilities = card.capabilities;
  const extensions =
    typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>).extensions
      : undefined;
  const list = Array.isArray(extensions) ? extensions : [];
  const matches = list.filter(isKcbExtension);
  if (matches.length === 0) {
    throw new ManifestError(
      `agent_card.capabilities.extensions must carry the KCB manifest extension ` +
        `(uri ${KCB_MANIFEST_EXTENSION_URI}), found none`,
    );
  }
  if (matches.length > 1) {
    throw new ManifestError(
      `agent_card.capabilities.extensions carries ${matches.length} KCB manifest extensions ` +
        `(uri ${KCB_MANIFEST_EXTENSION_URI}), expected exactly one`,
    );
  }
  const index = list.indexOf(matches[0]);
  const extension = object(matches[0], `agent_card.capabilities.extensions[${index}]`);
  return object(extension.params, `agent_card.capabilities.extensions[${index}].params`);
}

function isKcbExtension(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).uri === KCB_MANIFEST_EXTENSION_URI
  );
}

/**
 * Validate a bare KCB manifest `params` body — the payload of the AgentCard extension, on its
 * own — narrowing it in place. This is what {@link parseManifest} runs on the extracted
 * extension; callers holding a body directly (or a pre-card provider fixture) use it too.
 */
export function parseManifestBody(value: unknown): CapabilityManifest {
  const manifest = object(value, 'manifest');
  const version = string(manifest.kcb_version, 'manifest.kcb_version');
  if (!isCompatibleKcbVersion(version)) {
    throw new ManifestError(
      `manifest.kcb_version ${version} is not readable by KCB ${SPEC_VERSIONS.kcb}`,
    );
  }
  if (parseKinpId(manifest.identity) === undefined) {
    throw new ManifestError(`manifest.identity must be a KINP id, got ${show(manifest.identity)}`);
  }
  for (const [name, endpoint] of Object.entries(object(manifest.endpoints, 'manifest.endpoints'))) {
    string(endpoint, `manifest.endpoints.${name}`);
  }
  ports(manifest.produces, 'manifest.produces');
  ports(manifest.consumes, 'manifest.consumes');
  capabilities(manifest.capabilities);
  return manifest as unknown as CapabilityManifest;
}

/**
 * Narrowing guard over {@link parseManifest}, for callers that prefer a boolean. True only for
 * a full AgentCard carrying a readable KCB manifest extension — not for a bare `params` body.
 */
export function isCapabilityManifest(value: unknown): value is CapabilityManifest {
  try {
    parseManifest(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a {@link CapabilityManifest} as the single KCB {@link AgentExtension} of an AgentCard —
 * the inverse of the extraction {@link parseManifest} performs (§2/§6).
 *
 * The manifest body becomes the extension's `params` **verbatim**: it carries only the endpoints
 * the manifest already lists — no endpoint the source does not carry is invented, mirroring the
 * provider-router's "no dead endpoint" rule (`manifest.py`). The extension is marked
 * `required: false` per the capability-bus.md §2 example, so a reader that does not speak KCB can
 * still use the card's plain A2A surface.
 */
export function toAgentCardExtension(manifest: CapabilityManifest): AgentExtension {
  return {
    uri: KCB_MANIFEST_EXTENSION_URI,
    description: 'Koine capability-bus manifest',
    required: false,
    params: manifest as unknown as Record<string, unknown>,
  };
}

/**
 * Attach `manifest` to `card` as its KCB extension, returning a new card (§2/§6). Any existing
 * KCB extension is replaced — a card carries exactly one, and {@link parseManifest} rejects more
 * — while every other extension and every card field is preserved.
 */
export function embedManifest(card: AgentCard, manifest: CapabilityManifest): AgentCard {
  const capabilities = card.capabilities ?? {};
  const others = (capabilities.extensions ?? []).filter(
    (extension) => extension.uri !== KCB_MANIFEST_EXTENSION_URI,
  );
  return {
    ...card,
    capabilities: {
      ...capabilities,
      extensions: [...others, toAgentCardExtension(manifest)],
    },
  };
}

function capabilities(value: unknown): void {
  if (value === undefined) return;
  const list = array(value, 'manifest.capabilities');
  list.forEach((entry, index) => {
    const at = `manifest.capabilities[${index}]`;
    const capability = object(entry, at);
    string(capability.name, `${at}.name`);
    ports(capability.inputs, `${at}.inputs`);
    ports(capability.outputs, `${at}.outputs`);
    if (capability.cost !== undefined) {
      const cost = object(capability.cost, `${at}.cost`);
      if (typeof cost.est_units !== 'number' || !Number.isFinite(cost.est_units)) {
        throw new ManifestError(`${at}.cost.est_units must be a finite number`);
      }
    }
  });
}

function ports(value: unknown, at: string): void {
  if (value === undefined) return;
  array(value, at).forEach((entry, index) => {
    const port = object(entry, `${at}[${index}]`);
    if (!isPlane(port.plane)) {
      throw new ManifestError(`${at}[${index}].plane must be a KCB plane, got ${show(port.plane)}`);
    }
    if (port.plane === 'media') {
      array(port.media_types, `${at}[${index}].media_types`).forEach((type, i) =>
        string(type, `${at}[${index}].media_types[${i}]`),
      );
    }
    if (port.plane === 'entity') {
      array(port.types, `${at}[${index}].types`).forEach((type, i) =>
        string(type, `${at}[${index}].types[${i}]`),
      );
    }
  });
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError(`${at} must be an object, got ${show(value)}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new ManifestError(`${at} must be an array, got ${show(value)}`);
  return value;
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ManifestError(`${at} must be a non-empty string, got ${show(value)}`);
  }
  return value;
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
