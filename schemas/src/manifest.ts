/**
 * The KCB capability manifest — `koine/specs/capability-bus.md` §2.
 *
 * The manifest is what a provider publishes about itself and what the registry (§3)
 * indexes. Wire keys are `snake_case` exactly as the spec writes them: these objects
 * arrive verbatim from another process (the provider-router publishes one at
 * `/.well-known/kcb-manifest.json` from Python), so renaming them here would make the
 * TypeScript side a translation layer rather than a reader of the contract.
 *
 * `parseManifest` validates and *narrows* — it does not rebuild. A provider's manifest is
 * authoritative (§3); anything in it this version does not model must survive being read.
 */
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

/** Validate `value` as a capability manifest, narrowing it in place. Throws on junk. */
export function parseManifest(value: unknown): CapabilityManifest {
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

/** Narrowing guard over {@link parseManifest}, for callers that prefer a boolean. */
export function isCapabilityManifest(value: unknown): value is CapabilityManifest {
  try {
    parseManifest(value);
    return true;
  } catch {
    return false;
  }
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
