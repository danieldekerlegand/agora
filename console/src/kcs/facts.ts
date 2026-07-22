/**
 * Reading the data planes off the wire — what an observation *saw*, in KGP/KMI/KINP terms.
 *
 * KCS §7 Q2 is the reason this module exists. Model output varies run to run, so a
 * scenario must assert *structure and invariants* — which world a claim landed in, which
 * entities an asset attaches to, whether a `same_as` crossed a world boundary — never the
 * generated text. Assertions therefore read these extracted facts (§5), and nothing in
 * here comes from prose: a fact is only recorded when the peer stated it in a KGP/KMI/KINP
 * shape, so a provider that says the right thing in English still fails the assertion.
 *
 * Two rules keep the extraction honest:
 *
 * 1. **Absence is `undefined`, not a default.** A `source_world` the envelope never stated
 *    is not `null` — `null` is the *positive* claim "this asset depicts no world" (KMI
 *    delta H). Collapsing the two would let an ingested asset that forgot its world pass
 *    `source_world_is(asset, null)`.
 * 2. **Ids only, never bytes.** Everything here is a summary the observation log can hold
 *    (KMI §7): the payload lives at its provider, addressed by id.
 */
import { isJsonObject, worldOf, type Json, type JsonObject } from '@agora/schemas';

/**
 * KINP's reserved equivalence/lifecycle relations (§4.2/§4.3) plus KMI's asset-lineage
 * set (§3). A claim using one of these is *also* a link: it says how two ids relate,
 * which is what the firewall assertions traverse.
 */
export const LINK_RELATIONS: readonly string[] = [
  'same_as',
  'based_on',
  'part_of',
  'instance_of',
  'retracts',
  'supersedes',
  'media:derived_from',
  'media:variant_of',
  'media:excerpt_of',
  'media:perceptual_match',
];

/** The subset that records one asset being made from another (KMI §3, §5 attribution). */
export const LINEAGE_RELATIONS: readonly string[] = [
  'media:derived_from',
  'media:variant_of',
  'media:excerpt_of',
];

/** One KGP assertion as observed (KINP §7.1 envelope, summarised). */
export interface ObservedClaim {
  /** The content-addressed claim id, when the producer stated one (KGP §3). */
  id?: string | undefined;
  /** The world it holds in. `undefined` when the producer stated none — never assumed. */
  world?: string | undefined;
  relation: string;
  subject: string;
  object?: string | undefined;
  confidence?: number | undefined;
  /** The W3C-PROV block, when present. `provenance_present` is about exactly this. */
  prov?: JsonObject | undefined;
}

/** One KMI asset envelope as observed (KMI §2 / KINP §7.2, summarised). */
export interface ObservedAsset {
  id: string;
  media_type?: string | undefined;
  bytes?: number | undefined;
  /** `null` = generated, depicts no world (delta H). `undefined` = the envelope was silent. */
  source_world?: string | null | undefined;
  attaches_to: string[];
  /** Assets this one was made from — `excerpt.source` plus observed lineage links. */
  constituents: string[];
  /** False when the CAS had no bytes for it: a dangling reference (KCB delta L). */
  present: boolean;
}

/** A claim using a reserved relation, read as the edge it is. */
export interface ObservedLink {
  relation: string;
  from: string;
  to: string;
  world?: string | undefined;
  confidence?: number | undefined;
}

export interface Facts {
  claims: ObservedClaim[];
  assets: ObservedAsset[];
  links: ObservedLink[];
  /** Content-addressed pack ids seen (KGP §2.1). */
  packs: string[];
}

/** Containers a pack, a delta frame or a query result nests its records under. */
const CONTAINERS = [
  'assertions',
  'claims',
  'links',
  'assets',
  'attachments',
  'frames',
  'deltas',
  'events',
  'results',
  'data',
  'pack',
  'packs',
  'delta',
  'snapshot',
  'result',
];

/** Bounded so a cyclic or pathological body cannot walk forever. */
const MAX_DEPTH = 8;

export function noFacts(): Facts {
  return { claims: [], assets: [], links: [], packs: [] };
}

/** True when nothing on any plane was recognised — a control-plane-only exchange. */
export function isEmpty(facts: Facts): boolean {
  return (
    facts.claims.length === 0 &&
    facts.assets.length === 0 &&
    facts.links.length === 0 &&
    facts.packs.length === 0
  );
}

/** Every KINP id a set of facts touched, in first-seen order (what the log stamps). */
export function idsIn(facts: Facts): string[] {
  const seen = new Set<string>();
  for (const pack of facts.packs) seen.add(pack);
  for (const claim of facts.claims) {
    if (claim.id !== undefined) seen.add(claim.id);
    seen.add(claim.subject);
    if (claim.object !== undefined) seen.add(claim.object);
    if (claim.world !== undefined) seen.add(claim.world);
  }
  for (const asset of facts.assets) {
    seen.add(asset.id);
    for (const entity of asset.attaches_to) seen.add(entity);
    if (typeof asset.source_world === 'string') seen.add(asset.source_world);
  }
  for (const link of facts.links) {
    seen.add(link.from);
    seen.add(link.to);
  }
  return [...seen];
}

/** Read every plane-typed record a response body carries. Junk yields no facts, not a throw. */
export function readFacts(body: Json | undefined): Facts {
  const facts = noFacts();
  absorb(body, facts, 0);
  attributeConstituents(facts);
  return facts;
}

function absorb(value: Json | undefined, facts: Facts, depth: number): void {
  if (depth > MAX_DEPTH || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) absorb(entry, facts, depth + 1);
    return;
  }
  if (!isJsonObject(value)) return;
  if (typeof value.pack_id === 'string') facts.packs.push(value.pack_id);
  const claim = asClaim(value);
  if (claim !== undefined) {
    facts.claims.push(claim);
    const link = asLink(claim);
    if (link !== undefined) facts.links.push(link);
  }
  const asset = asAsset(value);
  if (asset !== undefined) facts.assets.push(asset);
  for (const key of CONTAINERS) {
    if (key in value) absorb(value[key], facts, depth + 1);
  }
}

/**
 * A KGP assertion envelope. `relation` + `subject` is the minimum that says anything —
 * an object with a `world` and nothing else is not a claim, it is a scoping header.
 */
function asClaim(value: JsonObject): ObservedClaim | undefined {
  const relation = value.relation;
  const subject = value.subject;
  if (typeof relation !== 'string' || typeof subject !== 'string') return undefined;
  const claim: ObservedClaim = { relation, subject };
  if (typeof value.id === 'string') claim.id = value.id;
  if (typeof value.world === 'string') claim.world = value.world;
  else if (value.world === null) claim.world = undefined;
  if (typeof value.object === 'string') claim.object = value.object;
  else if (value.object !== undefined && value.object !== null) {
    claim.object = JSON.stringify(value.object);
  }
  if (typeof value.confidence === 'number') claim.confidence = value.confidence;
  if (isJsonObject(value.prov)) claim.prov = value.prov;
  return claim;
}

function asLink(claim: ObservedClaim): ObservedLink | undefined {
  if (!LINK_RELATIONS.includes(claim.relation)) return undefined;
  if (claim.object === undefined) return undefined;
  const link: ObservedLink = { relation: claim.relation, from: claim.subject, to: claim.object };
  if (claim.world !== undefined) link.world = claim.world;
  if (claim.confidence !== undefined) link.confidence = claim.confidence;
  return link;
}

/** A KMI asset envelope: a KINP `asset` id, plus anything the envelope says about it. */
function asAsset(value: JsonObject): ObservedAsset | undefined {
  const id = value.id;
  if (typeof id !== 'string' || !id.includes(':asset:')) return undefined;
  const asset: ObservedAsset = {
    id,
    attaches_to: strings(value.attaches_to),
    constituents: [],
    present: value.present !== false,
  };
  if (typeof value.media_type === 'string') asset.media_type = value.media_type;
  if (typeof value.bytes === 'number') asset.bytes = value.bytes;
  // The distinction delta H turns on: stated-null (generated) vs. never stated at all.
  if (typeof value.source_world === 'string') asset.source_world = value.source_world;
  else if (value.source_world === null) asset.source_world = null;
  if (isJsonObject(value.excerpt) && typeof value.excerpt.source === 'string') {
    asset.constituents.push(value.excerpt.source);
  }
  return asset;
}

/**
 * Fold the lineage links into the assets they describe, so "what is this render made of"
 * is answerable from an asset alone. KMI §5 attributes a composite's analysis to its
 * *constituents'* worlds, and that walk starts here.
 */
function attributeConstituents(facts: Facts): void {
  for (const link of facts.links) {
    if (!LINEAGE_RELATIONS.includes(link.relation)) continue;
    for (const asset of facts.assets) {
      if (asset.id === link.from && !asset.constituents.includes(link.to)) {
        asset.constituents.push(link.to);
      }
    }
  }
}

function strings(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The world an id is named into (KINP §5), re-exported so assertion evaluators read the
 * grammar from one place rather than each splitting a CURIE their own way.
 */
export { worldOf };
