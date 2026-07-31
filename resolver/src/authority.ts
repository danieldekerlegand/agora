/**
 * The resolver that dials the authority — identity.md §11 decision 1: a deployment names ONE
 * canonical authority for real-world entities, anchored to Wikidata.
 *
 * Which service that is, is configuration: an endpoint the registry handed back plus an
 * optional KINP identity to attribute answers to. Nothing here knows the authority's name.
 *
 * Three things this module is careful about:
 *
 * 1. **It dials only what needs an authority.** Claims and assets are content-addressed and
 *    "never round-trip" (§6); agents, worlds and sources are not real-world entities. Only
 *    an `ent` id is worth a request, and everything else is answered locally — which is why
 *    a console with no authority at all still resolves the ids the registry hands it.
 * 2. **The closure is computed here, not stored** (§8, §4.1). The authority states the
 *    equivalence-layer edges; this walks them, and the walk *never crosses a `based_on`
 *    edge*. That single rule is the firewall (§4.3) — a closure that traversed lineage
 *    would return "fought a dragon" for the real Napoleon.
 * 3. **Unreachable is not failed.** Authority is a role, not a hard dependency (§11
 *    decision 1): a dial that fails falls back to the local cache, and a fallback is
 *    labelled `cache`, never `authority`.
 */
import {
  isJsonObject,
  kindOf,
  worldOf,
  type Json,
  type JsonObject,
  type KinpKind,
} from '@agora/schemas';

import { createMemoryCache, type ResolverCache } from './cache.ts';
import type { LinkStore } from './persistence.ts';
import { decideLink, mergePolicy, worldFor, type MergePolicy } from './policy.ts';
import {
  AuthorityUnreachableError,
  ResolverUnavailableError,
  type AuthorityResolver,
  type EntityRef,
  type LinkProposal,
  type ProvenanceRef,
  type ReconciliationCandidate,
  type ReconciliationQuery,
  type ReconciliationResult,
  type ResolvedIdentity,
} from './types.ts';

/** The slice of `fetch` the authority client uses — the platform `fetch` satisfies it. */
export interface AuthorityResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface AuthorityRequestInit {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export type AuthorityFetch = (
  url: string,
  init?: AuthorityRequestInit,
) => Promise<AuthorityResponse>;

export interface AuthorityOptions {
  /** The authority's base URL, as the registry handed it back — never hard-coded upstream. */
  endpoint: string;
  /** Defaults to the platform `fetch`. */
  fetch?: AuthorityFetch;
  /** Defaults to a fresh in-process cache (§8 "a local resolver cache for offline use"). */
  cache?: ResolverCache;
  /** Merge-policy overrides (§11 decision 2). */
  policy?: Partial<MergePolicy>;
  /**
   * KINP identity of the authority, for error messages and provenance. Optional because the
   * authority is whoever the endpoint turns out to be: with none declared the endpoint itself
   * is what a caller is told could not be reached, which is both neutral and actionable.
   */
  identity?: string;
  /**
   * The durable equivalence-layer store behind {@link AuthorityResolver.applied} and
   * {@link AuthorityResolver.reviewQueue} (§11 decision 2). Defaults to in-memory arrays that
   * do not survive a restart; pass a {@link LinkStore} to persist both lists. When one is
   * given the resolver rehydrates from it on construction and writes each decision through.
   */
  links?: LinkStore;
}

/** The kinds that have an authority at all (§6): everything else is minted and final. */
function needsAuthority(kind: KinpKind): boolean {
  return kind === 'ent';
}

export function createAuthorityResolver(options: AuthorityOptions): AuthorityResolver {
  const base = options.endpoint.replace(/\/$/, '');
  const http = options.fetch ?? platformFetch();
  const cache = options.cache ?? createMemoryCache();
  const policy = mergePolicy(options.policy);
  // No default identity: naming one would be this package deciding whose authority a
  // deployment dials. Undeclared, the endpoint is the identity (§11 decision 1 names a role).
  const authorityIdentity = options.identity ?? base;
  // Rehydrate both lists from the durable store when one is configured (§11 decision 2), so a
  // restart resumes with the links it had already applied and queued rather than an empty
  // equivalence layer. Without a store these are plain in-memory arrays, as before.
  const links = options.links;
  const reviewQueue: LinkProposal[] = links ? links.loadReviewQueue() : [];
  const applied: LinkProposal[] = links ? links.loadApplied() : [];

  async function resolve(ref: EntityRef): Promise<ResolvedIdentity> {
    const id = ref.id;
    if (id === undefined) {
      throw new ResolverUnavailableError(
        `cannot resolve ${JSON.stringify(ref.name ?? ref)}: a name is a descriptor, not an ` +
          'identifier — match it with reconcile (§4.5)',
      );
    }
    const kind = kindOf(id);
    if (kind === undefined) {
      throw new ResolverUnavailableError(`${JSON.stringify(id)} is not a KINP identifier (§3.2)`);
    }
    if (!needsAuthority(kind)) return selfResolution(id, kind);

    const url = `${base}/resolve/${encodeURIComponent(id)}${ref.world === undefined ? '' : `?world=${encodeURIComponent(ref.world)}`}`;
    let response: AuthorityResponse;
    try {
      response = await http(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (error) {
      return offline(id, error instanceof Error ? error.message : String(error));
    }
    // Unknown to the authority is a *local* answer, not a failure: an id minted offline is
    // valid before anyone has reconciled it (§6, "eventually-consistent, never blocking").
    if (response.status === 404) return selfResolution(id, kind);
    if (!response.ok) return offline(id, `authority answered ${response.status}`);
    const body = await response.json();
    if (!isJsonObject(body)) return offline(id, 'authority returned a non-object body');
    const resolved = readResolution(body, id, kind);
    cache.set(id, resolved);
    return resolved;
  }

  /** Replay what the authority last said, or say plainly that nobody can answer. */
  function offline(id: string, reason: string): ResolvedIdentity {
    const cached = cache.get(id);
    if (cached === undefined) throw new AuthorityUnreachableError(authorityIdentity, reason);
    return { ...cached, authority: 'cache' };
  }

  async function reconcile(query: ReconciliationQuery): Promise<ReconciliationResult> {
    const world = query.world ?? worldFor(query.of, policy);
    const lineageOnly = await lineageFrom(query.of);
    const url = `${base}/reconcile`;
    let response: AuthorityResponse;
    try {
      response = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ queries: { q0: openRefineQuery(query) } }),
      });
    } catch (error) {
      // Matching is a judgement, not a lookup: there is nothing to replay from cache, and
      // guessing locally is how a wrong `same_as` gets minted. Retry when the authority is
      // back — §6 makes that safe.
      throw new AuthorityUnreachableError(
        authorityIdentity,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok) {
      throw new AuthorityUnreachableError(authorityIdentity, `answered ${response.status}`);
    }
    const candidates = readCandidates(await response.json(), policy);
    const proposal = decideLink({ world, candidates, subject: query.of, lineageOnly, policy });
    // Nothing below-threshold or ambiguous is ever silently applied: a null-relation or
    // review proposal goes to the queue, only a cleared one to applied — and each write goes
    // through to the durable store so the split survives a restart (§11 decision 2).
    if (proposal.relation === null || proposal.review) {
      reviewQueue.push(proposal);
      links?.addReview(proposal);
    } else {
      applied.push(proposal);
      links?.addApplied(proposal);
    }
    return { candidates, proposal, authority: 'authority' };
  }

  /**
   * Candidates the subject can already reach *only* through `based_on` — §4.5's
   * never-promoted-by-transitivity set. Resolving the subject is how we learn them; if the
   * authority cannot say, the set is empty and the relation is decided on worlds alone,
   * which is the conservative direction (worlds differ → `based_on` anyway).
   */
  async function lineageFrom(subject: string | undefined): Promise<string[]> {
    if (subject === undefined) return [];
    try {
      const resolved = await resolve({ id: subject });
      return resolved.basedOn.filter((id) => !resolved.sameAs.includes(id));
    } catch {
      return [];
    }
  }

  return {
    resolve,
    reconcile,
    get reviewQueue() {
      return reviewQueue;
    },
    get applied() {
      return applied;
    },
  };
}

/** An id that needs no authority resolves to itself, with nothing claimed about it. */
function selfResolution(id: string, kind: KinpKind): ResolvedIdentity {
  const resolution: ResolvedIdentity = {
    id,
    kind,
    authority: 'local',
    confidence: 1,
    sameAs: [],
    basedOn: [],
    provenance: [],
    attachedAssets: [],
  };
  const world = worldOf(id);
  if (world !== undefined) resolution.world = world;
  return resolution;
}

/**
 * Read §8's `{ entity, same_as_closure[], based_on[], provenance[], attached_assets[] }`.
 *
 * Two framings are accepted because both are conformant: an authority may hand back the
 * equivalence-layer `links` as claims (§4.2 — they *are* assertions) and let the caller
 * compute the merged view, or precompute the two sets itself. When it sends links, the
 * closure is walked here — and only over `same_as`.
 */
export function readResolution(body: JsonObject, id: string, kind: KinpKind): ResolvedIdentity {
  const links = readLinks(body);
  const walked = closureOver(id, links);
  const resolution: ResolvedIdentity = {
    id,
    kind,
    authority: 'authority',
    confidence: 1,
    sameAs: union(walked.sameAs, ids(body.same_as_closure ?? body.same_as), dereferenced(body, id)),
    basedOn: union(walked.basedOn, ids(body.based_on)),
    provenance: provenance(body.provenance),
    attachedAssets: union(ids(body.attached_assets), ids(body.attaches_to)),
  };
  const world = worldOf(id) ?? stringOr(body.world);
  if (world !== undefined) resolution.world = world;
  // A `based_on` id that also arrived as `same_as` would let inference cross the firewall
  // through the back door; the licensing relation wins and the lineage entry is dropped.
  resolution.basedOn = resolution.basedOn.filter((entry) => !resolution.sameAs.includes(entry));
  return resolution;
}

/** An equivalence-layer edge, as the authority states it (§4.2). */
interface AuthorityLink {
  relation: string;
  from: string;
  to: string;
}

function readLinks(body: JsonObject): AuthorityLink[] {
  const links: AuthorityLink[] = [];
  for (const key of ['links', 'assertions', 'claims', 'equivalences']) {
    const value = body[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isJsonObject(entry)) continue;
      const relation = entry.relation;
      const from = entry.subject;
      const to = entry.object;
      if (typeof relation !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        continue;
      }
      links.push({ relation, from, to });
    }
  }
  return links;
}

/**
 * The `same_as` closure, and the `based_on` edges leaving it.
 *
 * `same_as` is walked in both directions — "facts flow both ways" (§4.2) — and transitively.
 * `based_on` is read from the closure outward and is **not** walked through: a lineage edge
 * is where the traversal stops, which is what makes it lineage rather than identity.
 */
export function closureOver(
  id: string,
  links: readonly AuthorityLink[],
): { sameAs: string[]; basedOn: string[] } {
  const closure = new Set<string>([id]);
  const frontier = [id];
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const link of links) {
      if (link.relation !== 'same_as') continue;
      const next = link.from === current ? link.to : link.to === current ? link.from : undefined;
      if (next === undefined || closure.has(next)) continue;
      closure.add(next);
      frontier.push(next);
    }
  }
  const basedOn: string[] = [];
  for (const link of links) {
    if (link.relation !== 'based_on' || !closure.has(link.from)) continue;
    if (!basedOn.includes(link.to) && !closure.has(link.to)) basedOn.push(link.to);
  }
  closure.delete(id);
  return { sameAs: [...closure], basedOn };
}

/** An id the authority dereferenced this one to is, by definition, the same referent. */
function dereferenced(body: JsonObject, id: string): string[] {
  const entity = body.entity;
  const named = isJsonObject(entity) ? entity.id : entity;
  if (typeof named !== 'string' || named === id) return [];
  return [named];
}

function openRefineQuery(query: ReconciliationQuery): JsonObject {
  const body: JsonObject = { query: query.query };
  if (query.type !== undefined) body.type = query.type;
  if (query.limit !== undefined) body.limit = query.limit;
  if (query.properties !== undefined) {
    body.properties = query.properties.map((property) => ({ pid: property.pid, v: property.v }));
  }
  return body;
}

/**
 * Read the OpenRefine reconciliation response (§4.5).
 *
 * The standard batches queries under their keys (`{"q0": {"result": [...]}}`); a single-query
 * service that answers `{"result": [...]}` is read the same way, because insisting on the
 * batch envelope for one query buys nothing. Candidates are re-sorted by confidence: the
 * decision rules downstream read `[0]` and `[1]` as top and runner-up, and a service that
 * returned them unordered would silently turn the ambiguity check into noise.
 */
export function readCandidates(body: unknown, policy: MergePolicy): ReconciliationCandidate[] {
  const results = resultArray(body);
  const candidates: ReconciliationCandidate[] = [];
  for (const entry of results) {
    if (!isJsonObject(entry)) continue;
    const id = entry.id;
    if (typeof id !== 'string') continue;
    const score = typeof entry.score === 'number' ? entry.score : 0;
    const candidate: ReconciliationCandidate = {
      id,
      score,
      confidence: normalize(score),
      match: entry.match === true,
      types: types(entry.type ?? entry.types),
      world: stringOr(entry.world) ?? worldFor(id, policy),
    };
    const name = stringOr(entry.name);
    if (name !== undefined) candidate.name = name;
    candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

function resultArray(body: unknown): Json[] {
  if (Array.isArray(body)) return body as Json[];
  if (!isJsonObject(body)) return [];
  if (Array.isArray(body.result)) return body.result as Json[];
  for (const value of Object.values(body)) {
    if (isJsonObject(value) && Array.isArray(value.result)) return value.result as Json[];
  }
  return [];
}

/**
 * OpenRefine scores are service-defined and commonly 0–100; KINP confidence is 0–1 (§7.1).
 * Anything above 1 is read as a percentage, which is the only reading that does not turn a
 * strong match into an over-threshold certainty by accident.
 */
function normalize(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const scaled = score > 1 ? score / 100 : score;
  return Math.min(1, scaled);
}

function types(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const read: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') read.push(entry);
    else if (isJsonObject(entry) && typeof entry.id === 'string') read.push(entry.id);
  }
  return read;
}

function provenance(value: Json | undefined): ProvenanceRef[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const read: ProvenanceRef[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) continue;
    const record: ProvenanceRef = {};
    if (typeof entry.agent === 'string') record.agent = entry.agent;
    if (typeof entry.activity === 'string') record.activity = entry.activity;
    if (typeof entry.asserted === 'string') record.asserted = entry.asserted;
    read.push(record);
  }
  return read;
}

function ids(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const read: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') read.push(entry);
    else if (isJsonObject(entry) && typeof entry.id === 'string') read.push(entry.id);
  }
  return read;
}

function union(...lists: readonly string[][]): string[] {
  const seen: string[] = [];
  for (const list of lists) {
    for (const entry of list) if (!seen.includes(entry)) seen.push(entry);
  }
  return seen;
}

function stringOr(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function platformFetch(): AuthorityFetch {
  const global = globalThis as { fetch?: AuthorityFetch };
  if (global.fetch === undefined) {
    throw new ResolverUnavailableError('resolver: no fetch implementation available');
  }
  return global.fetch.bind(globalThis) as AuthorityFetch;
}
