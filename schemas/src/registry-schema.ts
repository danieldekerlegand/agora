/**
 * The shared relation registry's schema and validator.
 *
 * The registry is data and lives in koine (`relation-registry.ts` says where); this module is
 * the tooling that reads it (ADR-0001). It validates the two artifacts together, because
 * neither is well-formed alone:
 *
 * - the **vocabulary** — `relations.tsv` + `relations/<domain>.tsv`, eight tab-separated
 *   columns per row. A row's `relation · arity · ordered arg_roles · symmetric` is its
 *   **signature**, and a signature is immutable once published: changing it silently changes
 *   every dependent claim id (KGP §3), so a change means a new relation name. {@link
 *   diffSignatures} is what catches an edit that changed one instead.
 * - the **bridge mappings** — `predicate-mapping.json`, one entry per bridged-project
 *   predicate family. An entry coins no relation: if it crosses as a claim (`edge` /
 *   `derived-rule`) it must *name* vocabulary relations in `koineRelations`, and if it does
 *   not, it must name none. That rule is the only thing keeping the two artifacts one
 *   vocabulary instead of two.
 *
 * Everything here is pure — text and JSON values in, validated structures out. Fetching them
 * is `@agora/sdk`'s relation-registry loader, so this module stays free of I/O and of any vendored
 * copy of the data.
 */
import { isDialectTier, isEgressClass, type DialectTier, type EgressClass } from './axes.ts';
import { RELATION_REGISTRY } from './relation-registry.ts';

/* ── the vocabulary (relations.tsv) ──────────────────────────────────────────────────── */

/** The eight columns of a vocabulary row, in order. A row with any other shape is junk. */
export const VOCABULARY_COLUMNS = [
  'relation',
  'arity',
  'arg_roles',
  'symmetric',
  'tier',
  'domain',
  'inverse',
  'description',
] as const;

/** One relation: a name that may appear in a claim, plus the signature that normalizes it. */
export interface RelationRow {
  readonly relation: string;
  readonly arity: number;
  /** Argument roles in order — the order is part of the signature (KGP §3.2 rule 1). */
  readonly argRoles: readonly string[];
  /** Symmetric relations sort their operands before hashing, so they take no inverse. */
  readonly symmetric: boolean;
  /** The dialect tier a consumer needs to evaluate this relation (KGP §5). */
  readonly tier: DialectTier;
  /** `core`, or the namespace prefixing the relation name (`cine:shows` → `cine`). */
  readonly domain: string;
  /** The name of the reading with the arguments swapped. Named, never given its own row. */
  readonly inverse?: string;
  readonly description: string;
  /** Which file the row came from — reported when a row is rejected. */
  readonly source: string;
}

/** A vocabulary file as fetched: where it came from, and its raw TSV text. */
export interface VocabularyFile {
  readonly path: string;
  readonly text: string;
}

/* ── the bridge mappings (predicate-mapping.json) ────────────────────────────────────── */

/** What a bridged predicate becomes on the canonical side. */
export const CANONICAL_KINDS = [
  'node',
  'node-property',
  'edge',
  'derived-rule',
  'temporal',
  'rule',
  'provenance',
  /** Crosses in neither direction; catalogued only so §7.2 has an explicit rule for it. */
  'none',
] as const;

export type CanonicalKind = (typeof CANONICAL_KINDS)[number];

export function isCanonicalKind(value: unknown): value is CanonicalKind {
  return typeof value === 'string' && (CANONICAL_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds that cross as a KGP claim. Exactly these must name relations in
 * `koineRelations`; every other kind must name none, or the mapping layer has started
 * coining vocabulary of its own.
 */
export const CLAIM_KINDS = ['edge', 'derived-rule'] as const satisfies readonly CanonicalKind[];

export function crossesAsClaim(kind: CanonicalKind): boolean {
  return (CLAIM_KINDS as readonly string[]).includes(kind);
}

/** One bridged-project predicate family and how it crosses. */
export interface MappingEntry {
  /** Stable within its project: retarget by superseding an entry, never by rewriting one. */
  readonly id: string | number;
  /** The predicate(s) the project actually emits, as it names them. Also stable. */
  readonly external: string;
  readonly canonicalKind: CanonicalKind;
  readonly canonicalType?: string;
  readonly canonicalTypes?: readonly string[];
  /** Which way it crosses — a key of the project's own `direction` legend. */
  readonly direction: string;
  /** KGP §5 tier, or `null` where the merged entry declared none (≠ `grounding-only`). */
  readonly dialect: DialectTier | null;
  /** KGP §7.2 class. `local-only` is filtered out at pack construction. */
  readonly egress: EgressClass;
  /** Vocabulary relations this normalizes to. Non-empty iff {@link crossesAsClaim}. */
  readonly koineRelations: readonly string[];
  /** True when the canonical side does not ship the schema this needs yet. */
  readonly pending: boolean;
  readonly sourceRow?: string | number;
  readonly notes?: string;
  readonly [key: string]: unknown;
}

/** One bridged project's half of the bridge. */
export interface ProjectMappings {
  readonly title: string;
  /** Legend for the entries' `direction` values. */
  readonly direction: Readonly<Record<string, string>>;
  readonly relations: readonly MappingEntry[];
  readonly [key: string]: unknown;
}

/** Where the vocabulary files sit, relative to the registry directory. */
export interface VocabularyIndex {
  readonly core: string;
  readonly domains: readonly string[];
}

/** A copy of the registry that is generated from the canonical one, never authored. */
export interface RegistryMirror {
  /** The project holding the mirror (a KINP namespace). */
  readonly project: string;
  /** Its path within that project's repo. */
  readonly path: string;
  /** How it is kept honest: regenerated from the canonical copy, with a drift gate. */
  readonly mode: 'generated-mirror';
  readonly [key: string]: unknown;
}

/** `predicate-mapping.json`, validated. */
export interface RegistryDocument {
  readonly registryVersion: string;
  readonly relationRegistry: VocabularyIndex;
  /**
   * The project hosting the canonical vocabulary every mapping targets, where the registry
   * names it. It is the canonical *side* of the bridge, so it is never one of `projects`:
   * its coverage is the vocabulary itself. Optional — a registry that declares no canonical
   * host is read as a bridge layer over a vocabulary nobody claims to own.
   */
  readonly canonicalProject?: string;
  /** Copies declared derived from this one. Regenerated; a hand edit is how a registry forks. */
  readonly mirrors?: readonly RegistryMirror[];
  /** The bridged projects, keyed by KINP namespace — whichever cast *this* registry covers. */
  readonly projects: Readonly<Record<string, ProjectMappings>>;
  readonly [key: string]: unknown;
}

/**
 * The bridged projects a registry covers, in declaration order. This is the registry's data:
 * agora pins the registry's *version and layout* (`relation-registry.ts`), never its cast, so
 * a deployment whose registry bridges an entirely different set of projects loads here
 * unchanged.
 */
export function bridgedProjectsOf(document: RegistryDocument): readonly string[] {
  return Object.keys(document.projects);
}

/** Both artifacts as one loaded registry — what a stability check compares. */
export interface RegistrySnapshot {
  readonly document: RegistryDocument;
  readonly relations: readonly RelationRow[];
}

/** Thrown by every validator here; the message names the offending path. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * True when a registry's `registryVersion` can be read by this build.
 *
 * Same major, and below 1.0 the same minor — pre-1.0 minors are breaking by convention, and
 * they have been: 0.2.0 still says `portability: [...]` where 0.3.0 says `dialect` + `egress`,
 * and 0.3.0 predates a bridged project this build expects to find.
 */
export function isCompatibleRegistryVersion(version: string): boolean {
  const theirs = version.split('.');
  const ours = RELATION_REGISTRY.version.split('.');
  if (theirs[0] !== ours[0]) return false;
  return ours[0] !== '0' || theirs[1] === ours[1];
}

/* ── parsing the vocabulary ──────────────────────────────────────────────────────────── */

/**
 * Parse the vocabulary TSVs into one relation list. Every file contributes to a single
 * namespace, so a name repeated across files is an error rather than an override — two rows
 * for one name is exactly the fork the registry exists to prevent.
 */
export function parseVocabulary(files: readonly VocabularyFile[]): readonly RelationRow[] {
  const rows: RelationRow[] = [];
  const byName = new Map<string, RelationRow>();
  for (const file of files) {
    for (const row of parseVocabularyFile(file)) {
      const clash = byName.get(row.relation);
      if (clash) {
        throw new RegistryError(
          `relation ${row.relation} is declared twice (${clash.source} and ${row.source}) — ` +
            `the vocabulary is one namespace`,
        );
      }
      byName.set(row.relation, row);
      rows.push(row);
    }
  }
  for (const row of rows) {
    if (row.inverse !== undefined && byName.has(row.inverse)) {
      throw new RegistryError(
        `${row.source}: ${row.relation}'s inverse ${row.inverse} also has a row of its own — ` +
          `an inverse is a reading of a relation, not a second relation (KGP §3.2 rule 1)`,
      );
    }
  }
  return rows;
}

function parseVocabularyFile(file: VocabularyFile): readonly RelationRow[] {
  const lines = file.text.split('\n').filter((line) => line.trim() !== '');
  const header = lines.shift();
  if (header === undefined) throw new RegistryError(`${file.path} is empty`);
  const columns = header.split('\t');
  if (columns.join('\t') !== VOCABULARY_COLUMNS.join('\t')) {
    throw new RegistryError(
      `${file.path} header must be ${VOCABULARY_COLUMNS.join(' / ')}, got ${header}`,
    );
  }
  return lines.map((line, index) => parseVocabularyRow(line, file.path, index + 2));
}

function parseVocabularyRow(line: string, path: string, lineNumber: number): RelationRow {
  const at = `${path}:${lineNumber}`;
  const cells = line.split('\t');
  if (cells.length !== VOCABULARY_COLUMNS.length) {
    throw new RegistryError(
      `${at} must have ${String(VOCABULARY_COLUMNS.length)} tab-separated columns, got ` +
        `${String(cells.length)} (an empty column still needs its tab)`,
    );
  }
  const [relation, arity, argRoles, symmetric, tier, domain, inverse, description] = cells as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^(?:[a-z][a-z0-9_]*:)?[a-z][a-z0-9_]*$/.test(relation)) {
    throw new RegistryError(`${at}: ${show(relation)} is not a relation name (\`[domain:]name\`)`);
  }
  const roles = argRoles.split('|');
  const count = Number(arity);
  if (!Number.isInteger(count) || count < 1) {
    throw new RegistryError(`${at}: arity must be a positive integer, got ${show(arity)}`);
  }
  if (roles.length !== count || roles.some((role) => role === '')) {
    throw new RegistryError(
      `${at}: arg_roles must be ${String(count)} non-empty \`|\`-separated roles, got ` +
        `${show(argRoles)}`,
    );
  }
  if (new Set(roles).size !== roles.length) {
    throw new RegistryError(`${at}: arg_roles must be distinct — they name argument positions`);
  }
  if (symmetric !== 'true' && symmetric !== 'false') {
    throw new RegistryError(`${at}: symmetric must be \`true\` or \`false\`, got ${show(symmetric)}`);
  }
  if (!isDialectTier(tier)) {
    throw new RegistryError(`${at}: tier must be a KGP §5 dialect tier, got ${show(tier)}`);
  }
  const prefix = relation.includes(':') ? relation.slice(0, relation.indexOf(':')) : 'core';
  if (domain !== prefix) {
    throw new RegistryError(
      `${at}: domain ${show(domain)} disagrees with the relation's namespace (${prefix})`,
    );
  }
  if (symmetric === 'true' && inverse !== '') {
    throw new RegistryError(`${at}: a symmetric relation is its own inverse, so it names none`);
  }
  if (description.trim() === '') {
    throw new RegistryError(`${at}: description must say what the relation asserts`);
  }
  return {
    relation,
    arity: count,
    argRoles: roles,
    symmetric: symmetric === 'true',
    tier,
    domain,
    ...(inverse === '' ? {} : { inverse }),
    description,
    source: path,
  };
}

/* ── parsing the mappings ────────────────────────────────────────────────────────────── */

/**
 * Validate `predicate-mapping.json`, narrowing it in place. Unknown keys survive: the
 * registry is a contract this build reads, not one it rebuilds, so a newer key it does not
 * model must pass through rather than be dropped.
 *
 * What is checked is **structure and self-consistency**, never membership in a cast of
 * projects: which projects a registry bridges is that registry's own declaration (see {@link
 * bridgedProjectsOf}), so a document naming projects this build has never heard of is a
 * registry it can read, not one it may reject.
 */
export function parseRegistry(value: unknown): RegistryDocument {
  const doc = object(value, 'registry');
  const version = string(doc.registryVersion, 'registry.registryVersion');
  if (!isCompatibleRegistryVersion(version)) {
    throw new RegistryError(
      `registry.registryVersion ${version} is not readable by this build ` +
        `(${RELATION_REGISTRY.version})`,
    );
  }
  vocabularyIndex(doc.relationRegistry);
  const canonical =
    doc.canonicalProject === undefined
      ? undefined
      : string(doc.canonicalProject, 'registry.canonicalProject');
  if (doc.mirrors !== undefined) {
    array(doc.mirrors, 'registry.mirrors').forEach((value_, index) =>
      mirror(value_, `registry.mirrors[${String(index)}]`),
    );
  }
  const projects = object(doc.projects, 'registry.projects');
  for (const name of Object.keys(projects)) {
    if (name === '') {
      throw new RegistryError(
        `registry.projects has an entry with an empty name — a key here is the project's KINP ` +
          `namespace, which is what a consumer's mappings are looked up by`,
      );
    }
    if (name === canonical) {
      throw new RegistryError(
        `registry.projects must not carry ${name}: the registry declares it the canonical ` +
          `project, so it hosts the vocabulary every mapping targets and is the canonical ` +
          `side of the bridge, never a bridged one`,
      );
    }
    project(projects[name], `registry.projects.${name}`);
  }
  return doc as unknown as RegistryDocument;
}

/** Narrowing guard over {@link parseRegistry}, for callers that prefer a boolean. */
export function isRegistryDocument(value: unknown): value is RegistryDocument {
  try {
    parseRegistry(value);
    return true;
  } catch {
    return false;
  }
}

function vocabularyIndex(value: unknown): void {
  const index = object(value, 'registry.relationRegistry');
  string(index.core, 'registry.relationRegistry.core');
  array(index.domains, 'registry.relationRegistry.domains').forEach((path, i) =>
    string(path, `registry.relationRegistry.domains[${String(i)}]`),
  );
}

function mirror(value: unknown, at: string): void {
  const entry = object(value, at);
  string(entry.project, `${at}.project`);
  string(entry.path, `${at}.path`);
  if (entry.mode !== 'generated-mirror') {
    throw new RegistryError(
      `${at}.mode must be \`generated-mirror\`, got ${show(entry.mode)} — a declared copy that ` +
        `may be authored is how the registry forks`,
    );
  }
}

function project(value: unknown, at: string): void {
  const mappings = object(value, at);
  string(mappings.title, `${at}.title`);
  const directions = object(mappings.direction, `${at}.direction`);
  const entries = array(mappings.relations, `${at}.relations`);
  if (entries.length === 0) {
    throw new RegistryError(`${at}.relations is empty — a bridged project with no mappings`);
  }
  const seen = new Set<string>();
  entries.forEach((value_, index) => {
    const entry = mappingEntry(value_, `${at}.relations[${String(index)}]`, directions);
    const id = String(entry.id);
    if (seen.has(id)) {
      throw new RegistryError(`${at}.relations has two entries with id ${id} — ids are stable`);
    }
    seen.add(id);
  });
}

function mappingEntry(
  value: unknown,
  at: string,
  directions: Readonly<Record<string, unknown>>,
): MappingEntry {
  const entry = object(value, at);
  if (typeof entry.id !== 'string' && typeof entry.id !== 'number') {
    throw new RegistryError(`${at}.id must be a string or a number, got ${show(entry.id)}`);
  }
  const external = string(entry.external, `${at}.external`);
  const kind = entry.canonicalKind;
  if (!isCanonicalKind(kind)) {
    throw new RegistryError(`${at}.canonicalKind must be one of ${CANONICAL_KINDS.join(' / ')}`);
  }
  const direction = string(entry.direction, `${at}.direction`);
  if (!Object.hasOwn(directions, direction)) {
    throw new RegistryError(
      `${at}.direction ${show(direction)} is not in the project's direction legend`,
    );
  }
  if (entry.dialect !== null && !isDialectTier(entry.dialect)) {
    throw new RegistryError(
      `${at}.dialect must be a KGP §5 tier or null, got ${show(entry.dialect)} ` +
        `(0.2.0's \`portability\` array is not readable by this build)`,
    );
  }
  if (!isEgressClass(entry.egress)) {
    throw new RegistryError(
      `${at}.egress must be a KGP §7.2 class, got ${show(entry.egress)}`,
    );
  }
  const relations = array(entry.koineRelations, `${at}.koineRelations`).map((name, i) =>
    string(name, `${at}.koineRelations[${String(i)}]`),
  );
  if (crossesAsClaim(kind) && relations.length === 0) {
    throw new RegistryError(
      `${at} crosses as a claim (${kind}) so it must name the vocabulary relations it ` +
        `normalizes to; a predicate with no relation is closed by adding one to the TSV`,
    );
  }
  if (!crossesAsClaim(kind) && relations.length > 0) {
    throw new RegistryError(
      `${at} is a ${kind}, which is not a claim, so koineRelations must be empty`,
    );
  }
  if (typeof entry.pending !== 'boolean') {
    throw new RegistryError(`${at}.pending must be a boolean, got ${show(entry.pending)}`);
  }
  if (entry.egress === 'local-only' && predicateNames(external).length === 0) {
    throw new RegistryError(
      `${at} is local-only but names no machine-readable predicate, so a producer cannot ` +
        `filter it out at pack construction (KGP §7.2)`,
    );
  }
  return entry as unknown as MappingEntry;
}

/**
 * Cross-check the two artifacts: every relation a mapping normalizes to must exist in the
 * vocabulary. A name that does not is the mapping layer coining vocabulary — the thing that
 * makes the registry two sources of truth instead of one.
 */
export function assertRelationsResolve(
  document: RegistryDocument,
  relations: readonly RelationRow[],
): void {
  const known = new Set(relations.map((row) => row.relation));
  for (const [name, mappings] of Object.entries(document.projects)) {
    for (const entry of mappings.relations) {
      for (const relation of entry.koineRelations) {
        if (!known.has(relation)) {
          throw new RegistryError(
            `registry.projects.${name} entry ${String(entry.id)} names relation ${relation}, ` +
              `which is in no vocabulary file — add it to the TSV by PR, never only here`,
          );
        }
      }
    }
  }
}

/* ── predicate extraction ────────────────────────────────────────────────────────────── */

/**
 * A predicate indicator at the head of a token: `name/arity` or `name(args)`, optionally
 * followed by a note (`married_to/2 (spouseId)`), or a bare name that is the whole token.
 * A token whose head is a word rather than an indicator (`cinematography facts/violations`)
 * matches nothing.
 */
const PREDICATE = /^([a-z][a-z0-9_]*)(?:\/\d+|\s*\([^)]*\)|$)/;

/**
 * The predicate names an entry's `external` field names, when it names them machine-readably
 * (`shows(asset, X)`, `country/1`, a bare `asset_technical`). An `external` written as prose
 * yields none — deliberately: a guess would silently widen an egress filter.
 *
 * That is why {@link parseRegistry} requires every `local-only` entry to yield at least one
 * name. A producer's §7.2 filter is built from these; an entry it cannot see is one it cannot
 * hold back.
 */
export function predicateNames(external: string): readonly string[] {
  const names: string[] = [];
  for (const token of splitTopLevel(external)) {
    const match = PREDICATE.exec(token.trim());
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Split on commas that are not inside brackets — `shows(asset, X)` is one token. */
function splitTopLevel(text: string): readonly string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      tokens.push(text.slice(start, i));
      start = i + 1;
    }
  }
  tokens.push(text.slice(start));
  return tokens;
}

/* ── immutability ────────────────────────────────────────────────────────────────────── */

/** A relation's identity for hashing purposes: `relation · arity · arg_roles · symmetric`. */
export function relationSignature(row: RelationRow): string {
  return [row.relation, String(row.arity), row.argRoles.join('|'), String(row.symmetric)].join(
    ' · ',
  );
}

/** Something that was published one way and now reads another way. */
export interface SignatureChange {
  /** A vocabulary row, or a mapping entry retargeted in place. */
  readonly kind: 'relation' | 'mapping-entry';
  /** The relation name, or `<project>#<id>`. */
  readonly name: string;
  readonly published: string;
  readonly candidate: string;
}

/**
 * What a candidate registry changed that it may not change: a published relation's signature
 * (KGP §3 — every dependent claim id moves with it) or a published mapping entry's `external`
 * (retarget by superseding the entry, never by rewriting it).
 *
 * Additions are not changes: a new relation name is exactly how a signature is meant to
 * evolve, and a removed one cannot break a claim id that was already minted.
 */
export function diffSignatures(
  published: RegistrySnapshot,
  candidate: RegistrySnapshot,
): readonly SignatureChange[] {
  const changes: SignatureChange[] = [];
  const before = new Map(published.relations.map((row) => [row.relation, relationSignature(row)]));
  for (const row of candidate.relations) {
    const was = before.get(row.relation);
    const now = relationSignature(row);
    if (was !== undefined && was !== now) {
      changes.push({ kind: 'relation', name: row.relation, published: was, candidate: now });
    }
  }
  const entries = new Map(externalsOf(published.document));
  for (const [name, now] of externalsOf(candidate.document)) {
    const was = entries.get(name);
    if (was !== undefined && was !== now) {
      changes.push({ kind: 'mapping-entry', name, published: was, candidate: now });
    }
  }
  return changes;
}

function externalsOf(document: RegistryDocument): readonly (readonly [string, string])[] {
  return Object.entries(document.projects).flatMap(([name, mappings]) =>
    mappings.relations.map((entry) => [`${name}#${String(entry.id)}`, entry.external] as const),
  );
}

/**
 * Reject a registry edit that moved a published signature. This is the gate a registry change
 * runs through: the alternative to catching it here is every consumer silently disagreeing
 * about what a claim id means.
 */
export function assertSignatureStability(
  published: RegistrySnapshot,
  candidate: RegistrySnapshot,
): void {
  const changes = diffSignatures(published, candidate);
  if (changes.length === 0) return;
  const detail = changes
    .map((change) => `${change.name}: ${change.published} → ${change.candidate}`)
    .join('; ');
  throw new RegistryError(
    `${String(changes.length)} published signature(s) changed, which changes every dependent ` +
      `claim id (KGP §3) — a change means a NEW name: ${detail}`,
  );
}

/* ── shared little validators ────────────────────────────────────────────────────────── */

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RegistryError(`${at} must be an object, got ${show(value)}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new RegistryError(`${at} must be an array, got ${show(value)}`);
  return value as unknown[];
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RegistryError(`${at} must be a non-empty string, got ${show(value)}`);
  }
  return value;
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
