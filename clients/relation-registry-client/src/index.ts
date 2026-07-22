/**
 * The relation-registry loader — how a consumer gets the shared registry.
 *
 * koine holds the data and agora holds the tooling (ADR-0001), so a consumer *loads* the
 * registry rather than vendoring it: one fetch of `predicate-mapping.json`, then the
 * vocabulary files that document itself names. Both go through `@agora/schemas`'s validator,
 * so nothing reaches a caller unvalidated, and the pair is cross-checked — a mapping that
 * names a relation no TSV declares is rejected at load, not discovered at claim time.
 *
 * What the loader adds over the validator is the two indexes a consumer actually needs:
 *
 * - {@link LoadedRegistry.relation} — a relation's published signature, for normalizing and
 *   hashing a claim (KGP §3.2);
 * - {@link LoadedRegistry.egressFor} — a project's predicates ⇄ their KGP §7.2 egress class,
 *   which is exactly the `RelationEgress` lookup `filterPackForEgress` and `assertPackEgress`
 *   take. The registry is where egress is *declared*; those two are where it is enforced.
 *
 * The loader fetches; it never writes and never mirrors. A cached copy is the caller's, and
 * a caller that edits one has forked the registry.
 */
import {
  assertRelationsResolve,
  DIALECT_TIERS,
  parseRegistry,
  parseVocabulary,
  predicateNames,
  RELATION_REGISTRY,
  relationSignature,
  type DialectTier,
  type EgressClass,
  type MappingEntry,
  type RegistryDocument,
  type RegistrySnapshot,
  type RelationEgress,
  type RelationRow,
} from '@agora/schemas';

/** The slice of `fetch` a load needs — structural, so a test can pass three lines. */
export type RegistryFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface LoadOptions {
  fetch?: RegistryFetch;
}

/** Thrown when the registry could not be retrieved. A validation failure is a RegistryError. */
export class RegistryFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'RegistryFetchError';
  }
}

/** The registry as a consumer uses it: the validated data, plus the lookups over it. */
export interface LoadedRegistry extends RegistrySnapshot {
  /** A published relation, or `undefined` — never a guess: an unknown relation is a bug. */
  relation(name: string): RelationRow | undefined;
  /** `relation · arity · arg_roles · symmetric`, the thing that must never change. */
  signature(name: string): string | undefined;
  /** One bridged project's mapping entries, in published order. */
  entries(project: string): readonly MappingEntry[];
  /**
   * The KGP §7.2 egress class of each predicate `project` emits, ready to hand to
   * `filterForEgress` / `assertPackEgress`. Undefined for a predicate the registry does not
   * mention — the caller decides, and `egressOf` defaults it to `exportable` (§7.2).
   */
  egressFor(project: string): RelationEgress;
  /**
   * The KGP §5 dialect tier each of `project`'s predicates needs to be evaluated. Where a
   * predicate appears in entries of differing tiers this reports the *highest*: a consumer
   * must be able to evaluate everything that arrives, not the easiest of it.
   */
  dialectFor(project: string): (predicate: string) => DialectTier | undefined;
}

/**
 * Load the shared registry from a koine checkout served over HTTP — a raw-file host, a mirror
 * of the repo, anything that serves `registry/…` under one base URL.
 *
 * The document names its own vocabulary files, so the loader follows the registry rather than
 * a hardcoded file list; it does check those paths against the layout this build pins
 * (`RELATION_REGISTRY.vocabulary`), because a registry that moved its files is one this build
 * cannot claim to speak.
 */
export async function loadRelationRegistry(
  baseUrl: string,
  options: LoadOptions = {},
): Promise<LoadedRegistry> {
  const get = options.fetch ?? (globalThis as { fetch?: RegistryFetch }).fetch;
  if (get === undefined) {
    throw new RegistryFetchError('no fetch implementation available', baseUrl);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const document = parseRegistry(JSON.parse(await text(get, `${base}/${RELATION_REGISTRY.mappings}`)));
  const files = await Promise.all(
    vocabularyPaths(document).map(async (path) => ({
      path,
      text: await text(get, `${base}/${path}`),
    })),
  );
  const relations = parseVocabulary(files);
  assertRelationsResolve(document, relations);
  return indexRegistry({ document, relations });
}

/** Index an already-fetched registry. The seam a caller with its own transport plugs into. */
export function indexRegistry(snapshot: RegistrySnapshot): LoadedRegistry {
  const rows = new Map(snapshot.relations.map((row) => [row.relation, row]));
  const egress = new Map<string, Map<string, EgressClass>>();
  const dialect = new Map<string, Map<string, DialectTier>>();
  for (const [project, mappings] of Object.entries(snapshot.document.projects)) {
    egress.set(project, indexEgress(mappings.relations));
    dialect.set(project, indexDialect(mappings.relations));
  }
  return {
    ...snapshot,
    relation: (name) => rows.get(name),
    signature: (name) => {
      const row = rows.get(name);
      return row === undefined ? undefined : relationSignature(row);
    },
    entries: (project) => snapshot.document.projects[project]?.relations ?? [],
    egressFor: (project) => {
      const index = egress.get(project);
      return (predicate) => index?.get(predicate);
    },
    dialectFor: (project) => {
      const index = dialect.get(project);
      return (predicate) => index?.get(predicate);
    },
  };
}

/** The vocabulary files the document names, resolved against the pinned registry layout. */
function vocabularyPaths(document: RegistryDocument): readonly string[] {
  const directory = RELATION_REGISTRY.mappings.slice(
    0,
    RELATION_REGISTRY.mappings.lastIndexOf('/'),
  );
  const index = document.relationRegistry;
  const core = `${directory}/${index.core}`;
  if (core !== RELATION_REGISTRY.vocabulary.core) {
    throw new RegistryFetchError(
      `registry declares its core vocabulary at ${core}, but this build speaks ` +
        `${RELATION_REGISTRY.vocabulary.core}`,
      core,
    );
  }
  const domains = index.domains.map((path) => `${directory}/${path}`);
  for (const path of domains) {
    if (!path.startsWith(`${RELATION_REGISTRY.vocabulary.domains}/`)) {
      throw new RegistryFetchError(
        `registry declares a domain vocabulary outside ${RELATION_REGISTRY.vocabulary.domains}`,
        path,
      );
    }
  }
  return [core, ...domains];
}

async function text(get: RegistryFetch, url: string): Promise<string> {
  const response = await get(url);
  if (!response.ok) {
    throw new RegistryFetchError(`registry fetch failed with ${String(response.status)}`, url);
  }
  return response.text();
}

/**
 * Predicate → egress class, **most restrictive wins**. Two entries naming one predicate is a
 * registry to fix, but until it is, a producer that treats the predicate as exportable has
 * already leaked; one that withholds it has only lost a record.
 */
function indexEgress(entries: readonly MappingEntry[]): Map<string, EgressClass> {
  const index = new Map<string, EgressClass>();
  for (const entry of entries) {
    for (const predicate of predicateNames(entry.external)) {
      if (index.get(predicate) === 'local-only') continue;
      index.set(predicate, entry.egress);
    }
  }
  return index;
}

/** Predicate → the highest dialect tier any entry declares for it. */
function indexDialect(entries: readonly MappingEntry[]): Map<string, DialectTier> {
  const index = new Map<string, DialectTier>();
  for (const entry of entries) {
    if (entry.dialect === null) continue;
    for (const predicate of predicateNames(entry.external)) {
      const known = index.get(predicate);
      const higher =
        known === undefined || DIALECT_TIERS.indexOf(entry.dialect) > DIALECT_TIERS.indexOf(known);
      if (higher) index.set(predicate, entry.dialect);
    }
  }
  return index;
}
