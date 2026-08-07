/**
 * A KGP claim as a producer submits it, and the §3 byte discipline that gives it its id.
 *
 * This is the one piece of the bridge that MUST be identical in every producer: KGP §3 is
 * normative that "cross-producer claim dedup works **only** if every producer reduces a claim
 * to the identical byte string before hashing", and ADR-0006 is the record of *why* that byte
 * discipline is koine's own rather than borrowed from RDF-star/JSON-LD — those model graphs and
 * annotations, and claim identity lives a layer below, in bytes.
 *
 * What is hashed is only the claim's identity-bearing content (§3.1) — `world`, `relation` and
 * the arguments. `confidence`, `embedding_model`, `valid_time`, `license`, `egress` and all of
 * `prov` are deliberately **excluded**, which is the whole point: the same fact from two
 * producers mints the same id and merges, while both provenance records survive (§3.3).
 *
 * The signature that fixes arity and argument order is the shared registry's, never the
 * producer's ({@link canonicalClaim} takes the registry row) — so nothing here is specific to
 * whoever is submitting, and a producer cannot decide its own argument order.
 */
import { createHash } from 'node:crypto';

import type { Json, RelationRow } from '@agora/schemas';

/** Thrown when a claim cannot be reduced to a canonical byte string at all. */
export class ClaimError extends Error {
  /** The rejection code `admitClaims` (./admission.ts) grades this failure as. */
  readonly code: 'arity-mismatch' | 'malformed-argument' | 'malformed-world';

  constructor(message: string, code: ClaimError['code'] = 'malformed-argument') {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

/**
 * A typed literal argument (§3.2 rule 5). An argument that is a plain `string` is an
 * **identifier** (a CURIE); a literal is always this envelope, so "the string `same_as`" and
 * "the entity `same_as`" can never canonicalize to the same bytes.
 */
export type ClaimLiteral =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'integer'; readonly value: number }
  | { readonly type: 'decimal'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'datetime'; readonly value: string }
  /** `value^^type-curie`, for when a bare literal would be ambiguous. */
  | { readonly type: 'typed'; readonly value: string; readonly datatype: string };

/** One argument of a claim: an identifier CURIE, or a typed literal. */
export type ClaimArgument = string | ClaimLiteral;

/**
 * PROV-shaped provenance (KGP §2/§7). `source` is required because "who told us this" must
 * always be answerable — it is what the merge-review queue and the trust filter read.
 */
export interface ClaimProvenance {
  /** Acquisition source: a KINP namespace, or an external authority. */
  readonly source: string;
  readonly confidence?: number;
  readonly [key: string]: Json | undefined;
}

/** A claim as it arrives from a producer — the KINP assertion envelope (identity.md §7.1). */
export interface Claim {
  /** The world this is asserted in (KINP §5), as a canonical CURIE. */
  readonly world: string;
  /** A relation name from the shared vocabulary. An unregistered one is rejected, not coined. */
  readonly relation: string;
  /** Arguments in the registry's published order — arity and order are not producer-dependent. */
  readonly args: readonly ClaimArgument[];
  /** Excluded from the hash (§3.1); a first-class filter (§7). */
  readonly confidence?: number;
  /** Excluded from the hash (§3.1). */
  readonly valid_time?: Json;
  /** Excluded from the hash (§3.1) — a consumer whose model differs re-embeds (§9 decision 2). */
  readonly embedding_model?: string;
  readonly prov?: ClaimProvenance;
  /** SPDX id or ecosystem pseudo-id; the §7.1 admission axis. Rides on the record, not the hash. */
  readonly license?: string;
  /** The §7.2 egress class, when the record carries its own. */
  readonly egress?: string;
  /** The id the producer minted, when it minted one. Re-derived here and cross-checked. */
  readonly id?: string;
}

/** True when an argument is a typed literal rather than an identifier. */
export function isClaimLiteral(value: unknown): value is ClaimLiteral {
  return typeof value === 'object' && value !== null && 'type' in value && 'value' in value;
}

/** `[A-Za-z0-9][A-Za-z0-9._-]*` — the segment grammar shared by KINP ids and `cs:` entity ids. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An identifier argument in canonical CURIE form (§3.2 rule 3): NFC, with the namespace and
 * kind segments lowercased. The local id is opaque and is never case-folded — `cs:culture:Q11768`
 * and `worldsim:world:alderforest:ent:npc-renaud` both survive verbatim below their kind.
 *
 * A **provisional-local** id (`analyzer:local:ent:e-8842`, §3.3) is emitted as-is: it will
 * re-normalize once the resolver reconciles it (KINP §6), so folding it here would only mint a
 * second id for a reference that is already known to be temporary.
 *
 * The IRI form is never accepted — §3.2 rule 3 is explicit that arguments are emitted as the
 * canonical CURIE, "never the IRI".
 */
export function canonicalIdentifier(value: string): string {
  const nfc = value.normalize('NFC');
  const parts = nfc.split(':');
  if (parts.length < 3 || parts.some((part) => part === '' || /\s/.test(part))) {
    throw new ClaimError(
      `${show(value)} is not a CURIE identifier (\`<namespace>:<kind>:<local-id>\`, KINP §3.2)`,
    );
  }
  const [namespace = '', second = ''] = parts;
  if (!SEGMENT.test(namespace) || !SEGMENT.test(second)) {
    throw new ClaimError(`${show(value)} has a namespace or kind segment outside the grammar`);
  }
  // A provisional-local id is emitted as-is; it re-normalizes post-reconciliation (§3.2 rule 3).
  if (second.toLowerCase() === 'local') return nfc;
  const worldScoped = parts.length >= 5 && second.toLowerCase() === 'world';
  const kindIndex = worldScoped ? 3 : 1;
  const kind = parts[kindIndex];
  if (kind === undefined || !SEGMENT.test(kind)) {
    throw new ClaimError(`${show(value)} has no kind segment at position ${String(kindIndex + 1)}`);
  }
  const out = [...parts];
  out[0] = namespace.toLowerCase();
  out[1] = second.toLowerCase();
  out[kindIndex] = kind.toLowerCase();
  return out.join(':');
}

/** A literal argument's canonical byte form (§3.2 rule 5). */
export function canonicalLiteral(literal: ClaimLiteral): string {
  switch (literal.type) {
    case 'string':
      return quote(literal.value);
    case 'integer':
      if (!Number.isSafeInteger(literal.value)) {
        throw new ClaimError(`integer literal ${String(literal.value)} is not a safe integer`);
      }
      // String() already yields base-10 with no leading zeros, no `+`, and `-0` → `0`.
      return String(literal.value);
    case 'decimal':
      return canonicalDecimal(literal.value);
    case 'boolean':
      return literal.value ? 'true' : 'false';
    case 'datetime':
      return canonicalDateTime(literal.value);
    case 'typed':
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*:[^\s:]+$/.test(literal.datatype)) {
        throw new ClaimError(`${show(literal.datatype)} is not a type CURIE (\`prefix:name\`)`);
      }
      return `${quote(literal.value)}^^${literal.datatype.normalize('NFC')}`;
  }
}

/** One argument, whichever kind it is. */
export function canonicalArgument(argument: ClaimArgument): string {
  if (typeof argument === 'string') return canonicalIdentifier(argument);
  if (!isClaimLiteral(argument)) {
    throw new ClaimError(`${show(String(argument))} is neither an identifier nor a typed literal`);
  }
  return canonicalLiteral(argument);
}

/**
 * `HASH_INPUT` for a claim (§3.1): `world · "|" · relation · "(" · arg1 · "," · … · ")"`, with
 * no insignificant whitespace anywhere (rule 6).
 *
 * `row` is the **registry's** published signature, so arity is checked and a symmetric
 * relation's operands are sorted ascending before emission (rule 2) — which is what makes
 * `same_as(a,b)` and `same_as(b,a)` one claim.
 */
export function canonicalClaim(claim: Claim, row: RelationRow): string {
  if (claim.relation !== row.relation) {
    throw new ClaimError(
      `claim relation ${show(claim.relation)} does not match the registry row ${show(row.relation)}`,
    );
  }
  if (claim.args.length !== row.arity) {
    throw new ClaimError(
      `${row.relation} is published with arity ${String(row.arity)} (${row.argRoles.join(', ')}) ` +
        `but the claim carries ${String(claim.args.length)} argument(s) — arity and argument ` +
        `order are the registry's, not the producer's (KGP §3.2 rule 1)`,
      'arity-mismatch',
    );
  }
  let world: string;
  try {
    world = canonicalIdentifier(claim.world);
  } catch (error) {
    throw new ClaimError(
      `world: ${error instanceof Error ? error.message : String(error)}`,
      'malformed-world',
    );
  }
  const args = claim.args.map(canonicalArgument);
  if (row.symmetric) args.sort(byBytes);
  return `${world}|${row.relation}(${args.join(',')})`;
}

/** `sha256-<lowerhex>` of a `HASH_INPUT` (§3.1). SHA-256 is mandated for interoperability. */
export function hashClaimInput(input: string): string {
  return `sha256-${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

/** The content-addressed claim id of one claim under its published signature (§3). */
export function claimId(claim: Claim, row: RelationRow): string {
  return hashClaimInput(canonicalClaim(claim, row));
}

/**
 * The KINP assertion-envelope id a pack record carries (identity.md §7.1):
 * `<namespace>:claim:<claim-id>`. The namespace is the *minting* producer's; the claim id
 * inside it is content-addressed, so two producers' envelopes carry the same id after the colon
 * and dedup on it.
 */
export function assertionId(namespace: string, id: string): string {
  return `${namespace}:claim:${id}`;
}

/* ── literal canonicalization ────────────────────────────────────────────────────────── */

/** NFC, wrapped in `"`, with inner `"` and `\` backslash-escaped — and no other escapes. */
function quote(value: string): string {
  return `"${value.normalize('NFC').replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** ISO-8601 in UTC, `Z` suffix, millisecond precision fixed (§3.2 rule 5). */
function canonicalDateTime(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new ClaimError(`${show(value)} is not a date/time literal`);
  }
  return at.toISOString();
}

/**
 * Shortest round-tripping base-10, no trailing zeros, no exponent unless |exp| ≥ 16, lowercase
 * `e` (§3.2 rule 5).
 *
 * JavaScript's own `String(n)` is the shortest round-tripping form but switches to exponential
 * at 1e21 / 1e-7 rather than at the rule's ±16, so the digits are taken from it and the
 * *placement* of the point is redone here. A positive exponent carries no `+`: the rule names
 * only a lowercase `e`, and a sign that carries no information is one more byte two producers
 * could disagree about.
 */
export function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ClaimError(`decimal literal ${String(value)} is not a finite number`);
  }
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const [digits, exponent] = shortestDigits(Math.abs(value));
  const scientific = exponent + digits.length - 1;
  if (Math.abs(scientific) >= 16) {
    const first = digits.slice(0, 1);
    const rest = digits.slice(1);
    const mantissa = rest === '' ? first : `${first}.${rest}`;
    return `${sign}${mantissa}e${String(scientific)}`;
  }
  if (exponent >= 0) return `${sign}${digits}${'0'.repeat(exponent)}`;
  const point = digits.length + exponent;
  if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}0.${'0'.repeat(-point)}${digits}`;
}

/**
 * The shortest round-tripping digits of a positive finite number and their base-10 exponent:
 * `value === Number(digits) * 10 ** exponent`, with no leading or trailing zeros in `digits`.
 */
function shortestDigits(value: number): [string, number] {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (match === null) throw new ClaimError(`cannot canonicalize the decimal ${text}`);
  const [, whole = '', fraction = '', exponent = '0'] = match;
  const stripped = `${whole}${fraction}`.replace(/^0+/, '');
  const trimmed = stripped.replace(/0+$/, '');
  const scale = Number(exponent) - fraction.length + (stripped.length - trimmed.length);
  return [trimmed, scale];
}

/** Ascending by code unit — the ordering §3.2 rule 2 sorts a symmetric relation's operands by. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function show(value: string): string {
  return JSON.stringify(value);
}
