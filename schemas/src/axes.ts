/**
 * The three axes that ride on knowledge, and the §7.2 egress enforcement.
 *
 * The registry's old `portabilityClasses` key bundled two orthogonal things into one enum,
 * which made `local-only` read as a fourth dialect tier. KGP 0.4.0 ruled otherwise and
 * `koine/registry/predicate-mapping.json` 0.3.0 split the key, so a relation now carries a
 * `dialect` and an `egress` independently:
 *
 * | Axis | Question | Spec | Enforcing? |
 * |---|---|---|---|
 * | **dialect** | what logic may a consumer *evaluate*? | KGP §5 | yes |
 * | **egress**  | may this leave its tier *at all*?     | KGP §7.2 | yes |
 * | **trust**   | how much should we *believe* a source? | KGP §7 / KINP §11 | no — descriptive |
 *
 * They are independent: `personal` trust *correlates* with `local-only` egress but does not
 * imply it, and a `grounding-only` fact can still be un-exportable. All three are called
 * "tier" somewhere in the projects' code (ADR-0002, "Terminology collisions") — the types
 * here are distinct so a mix-up is a compile error rather than a privacy leak.
 *
 * Egress is enforced in **both** directions (§7.2), and the producer side is the one that
 * matters: {@link filterPackForEgress} drops `local-only` at pack construction, and
 * {@link inspectPackEgress} / {@link assertPackEgress} let a consumer reject-and-report a
 * pack that still contains some — reporting, never silently dropping, because silence hides
 * the producer bug or tamper that put them there. Egress is not part of the claim hash
 * (§3.1), so neither direction can change what a claim *is*.
 */

/* ── dialect (KGP §5) ────────────────────────────────────────────────────────────────── */

/** Dialect tiers, **in nesting order**: `grounding-only` ⊂ `horn-safe` ⊂ `full-prolog`. */
export const DIALECT_TIERS = ['grounding-only', 'horn-safe', 'full-prolog'] as const;

export type DialectTier = (typeof DIALECT_TIERS)[number];

/** The lowest common denominator, and the default for cross-project transfer (§5). */
export const DEFAULT_DIALECT: DialectTier = 'grounding-only';

export function isDialectTier(value: unknown): value is DialectTier {
  return typeof value === 'string' && (DIALECT_TIERS as readonly string[]).includes(value);
}

/**
 * True when a consumer that can safely evaluate `evaluable` may ingest a pack declaring
 * `packed`. The tiers nest, so this is `packed ≤ evaluable` — "a producer must ship the
 * lowest tier that carries the needed content; a consumer must reject a pack whose tier
 * exceeds what it can safely evaluate" (§5).
 */
export function dialectAdmits(evaluable: DialectTier, packed: DialectTier): boolean {
  return DIALECT_TIERS.indexOf(packed) <= DIALECT_TIERS.indexOf(evaluable);
}

/* ── egress (KGP §7.2) ───────────────────────────────────────────────────────────────── */

/** Egress classes (§7.2). `local-only` is an egress class, *not* a dialect tier. */
export const EGRESS_CLASSES = ['exportable', 'local-only'] as const;

export type EgressClass = (typeof EGRESS_CLASSES)[number];

/** Unmarked content may cross, subject to licence (§7.1) and dialect (§5). */
export const DEFAULT_EGRESS: EgressClass = 'exportable';

export function isEgressClass(value: unknown): value is EgressClass {
  return typeof value === 'string' && (EGRESS_CLASSES as readonly string[]).includes(value);
}

/* ── trust (KGP §7 / KINP §11) — named here only to keep it distinct ─────────────────── */

/**
 * Provenance trust tiers as conformant projects already ship them: a knowledge authority's
 * admission states plus the bridges' source kinds. **Descriptive** — trust drives the
 * merge-review queue (KINP §11
 * decision 2), it never decides whether something may be exported. That is `egress`.
 */
export const TRUST_TIERS = [
  'curated',
  'auto-admitted',
  'quarantine',
  'synthetic',
  'personal',
] as const;

export type TrustTier = (typeof TRUST_TIERS)[number];

export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value);
}

/* ── enforcement ─────────────────────────────────────────────────────────────────────── */

/**
 * The little a record must have for egress to be decidable: its own marking, or a relation
 * the registry marks. Anything else about the record is the caller's business.
 */
export interface EgressBearing {
  readonly id?: string;
  readonly relation?: string;
  /** The record's own egress class, when it carries one (§7.2: "on relations and on records"). */
  readonly egress?: string;
}

/**
 * Egress class of a relation, per the shared registry — the koine mapping entry's `egress`.
 * Supplied by the caller (the registry loader) so this module stays free of I/O.
 */
export type RelationEgress = (relation: string) => EgressClass | undefined;

/**
 * The egress class governing one record: its own marking, else its relation's, else the
 * `exportable` default.
 *
 * **Fails closed.** A marking this build does not recognise resolves to `local-only`: an
 * egress class we cannot interpret is one we cannot prove is safe to export, and the cost of
 * being wrong is asymmetric — withholding a record is recoverable, leaking one is not.
 */
export function egressOf(record: EgressBearing, ofRelation?: RelationEgress): EgressClass {
  if (record.egress !== undefined) {
    return isEgressClass(record.egress) ? record.egress : 'local-only';
  }
  if (record.relation !== undefined && ofRelation) {
    const declared = ofRelation(record.relation);
    if (declared !== undefined) return declared;
  }
  return DEFAULT_EGRESS;
}

/** True when this record may cross a project boundary at all (§7.2). */
export function isExportable(record: EgressBearing, ofRelation?: RelationEgress): boolean {
  return egressOf(record, ofRelation) === 'exportable';
}

/** A record the producer kept back, and why — reported, so a filter is never silent. */
export interface Withheld<T> {
  readonly record: T;
  readonly egress: EgressClass;
}

/** What {@link filterForEgress} produces: what may go, and what was held back. */
export interface EgressFilter<T> {
  readonly emitted: readonly T[];
  readonly withheld: readonly Withheld<T>[];
}

/**
 * **Producer side (§7.2).** Split records into what may cross a project boundary and what
 * must not. Call this at pack construction — the filter is the producer's obligation and is
 * never left to the consumer.
 */
export function filterForEgress<T extends EgressBearing>(
  records: readonly T[],
  ofRelation?: RelationEgress,
): EgressFilter<T> {
  const emitted: T[] = [];
  const withheld: Withheld<T>[] = [];
  for (const record of records) {
    const egress = egressOf(record, ofRelation);
    if (egress === 'exportable') emitted.push(record);
    else withheld.push({ record, egress });
  }
  return { emitted, withheld };
}

/** The record-bearing sections of a KGP pack (§2), the ones egress applies to. */
export const PACK_SECTIONS = ['entities', 'assertions', 'links', 'provenance'] as const;

export type PackSection = (typeof PACK_SECTIONS)[number];

/**
 * As much of a GroundingPack (§2) as egress control needs: the four record sections. Every
 * other key of the pack is carried through untouched — this module reads packs, it does not
 * define them.
 */
export type PackLike = {
  readonly [S in PackSection]?: readonly EgressBearing[];
} & { readonly [key: string]: unknown };

/** Where a `local-only` record was found, and what marked it. */
export interface EgressViolation {
  readonly section: PackSection;
  readonly index: number;
  readonly id?: string;
  readonly relation?: string;
  readonly egress: EgressClass;
}

/** A consumer's verdict on a pack: clean, or the full list of what disqualifies it. */
export interface EgressReport {
  readonly ok: boolean;
  readonly violations: readonly EgressViolation[];
}

/**
 * **Consumer side (§7.2).** Report every `local-only` record in a pack that crossed a
 * boundary. A non-empty report means a producer bug or a tampered pack.
 */
export function inspectPackEgress(pack: PackLike, ofRelation?: RelationEgress): EgressReport {
  const violations: EgressViolation[] = [];
  for (const section of PACK_SECTIONS) {
    const records = pack[section];
    if (!Array.isArray(records)) continue;
    records.forEach((record: EgressBearing, index) => {
      const egress = egressOf(record, ofRelation);
      if (egress === 'exportable') return;
      violations.push({
        section,
        index,
        ...(record.id === undefined ? {} : { id: record.id }),
        ...(record.relation === undefined ? {} : { relation: record.relation }),
        egress,
      });
    });
  }
  return { ok: violations.length === 0, violations };
}

/** Thrown when a consumer rejects a pack for carrying content that should never have left. */
export class EgressError extends Error {
  readonly violations: readonly EgressViolation[];

  constructor(message: string, violations: readonly EgressViolation[]) {
    super(message);
    this.name = 'EgressError';
    this.violations = violations;
  }
}

/**
 * **Consumer side (§7.2), the enforcing form.** Reject a pack carrying `local-only` content,
 * loudly. The spec requires reporting rather than silently dropping the offending records,
 * so the violations ride on the error.
 */
export function assertPackEgress(pack: PackLike, ofRelation?: RelationEgress): void {
  const report = inspectPackEgress(pack, ofRelation);
  if (report.ok) return;
  const where = report.violations
    .map((v) => `${v.section}[${v.index}]${v.id === undefined ? '' : ` ${v.id}`}`)
    .join(', ');
  throw new EgressError(
    `pack carries ${String(report.violations.length)} record(s) that must never have left ` +
      `their tier (KGP §7.2): ${where}`,
    report.violations,
  );
}

/**
 * **Producer side, whole-pack.** Rebuild a pack with every non-exportable record removed,
 * reporting what was held back. The result satisfies {@link assertPackEgress} by
 * construction — which is exactly the §7.2 contract between the two sides.
 */
export function filterPackForEgress<T extends PackLike>(
  pack: T,
  ofRelation?: RelationEgress,
): { readonly pack: T; readonly withheld: readonly Withheld<EgressBearing>[] } {
  const filtered: Record<string, unknown> = { ...pack };
  const withheld: Withheld<EgressBearing>[] = [];
  for (const section of PACK_SECTIONS) {
    const records = pack[section];
    if (!Array.isArray(records)) continue;
    const result = filterForEgress(records as readonly EgressBearing[], ofRelation);
    filtered[section] = result.emitted;
    withheld.push(...result.withheld);
  }
  return { pack: filtered as T, withheld };
}
