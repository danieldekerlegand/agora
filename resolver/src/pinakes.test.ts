import { describe, expect, it } from 'vitest';

import {
  AuthorityUnreachableError,
  createMemoryCache,
  createPinakesResolver,
  mergePolicy,
  readCandidates,
  type AuthorityFetch,
  type AuthorityResponse,
} from './index.ts';

const ALDERFOREST = 'insimul:world:alderforest';
const REALITY = 'pinakes:world:consensus-reality';
const RENAUD = `${ALDERFOREST}:ent:npc-renaud`;
const ENDPOINT = 'https://pinakes.example/resolver';

/**
 * The authority as a lookup table, plus the log of what was dialed.
 *
 * The log is the point of several tests below: "the resolver did not call anybody" is the
 * assertion that content-addressed ids never round-trip (§6), and it cannot be made by
 * looking at the answer alone.
 */
function authority(routes: Record<string, { status?: number; body?: unknown }>): {
  fetch: AuthorityFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: AuthorityFetch = (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const route = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    const { status = 200, body = {} } = route?.[1] ?? { status: 404, body: { detail: 'unknown' } };
    const response: AuthorityResponse = { ok: status < 400, status, json: () => Promise.resolve(body) };
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

/** The §4.3 worked case as the authority states it: two `same_as`, one `based_on` between. */
const EQUIVALENCE_LAYER = {
  entity: { id: RENAUD, kind: 'ent' },
  links: [
    { subject: 'analyzer:ent:e-8842', relation: 'same_as', object: RENAUD, confidence: 0.9 },
    { subject: RENAUD, relation: 'based_on', object: 'pinakes:ent:napoleon-i', confidence: 0.83 },
    {
      subject: 'pinakes:ent:napoleon-i',
      relation: 'same_as',
      object: 'wikidata:ent:q517',
      confidence: 1,
    },
  ],
  provenance: [
    { agent: 'pinakes:agent:resolver', activity: 'analyzer:src:run-1a2b', asserted: '2026-07-18T06:20:00Z' },
  ],
  attached_assets: ['analyzer:asset:sha256-aa11'],
};

describe('resolve against the authority (§8)', () => {
  it('closes over same_as and stops dead at based_on', async () => {
    const { fetch } = authority({ '/resolve/': { body: EQUIVALENCE_LAYER } });
    const resolved = await createPinakesResolver({ endpoint: ENDPOINT, fetch }).resolve({
      id: RENAUD,
    });

    expect(resolved).toEqual({
      id: RENAUD,
      kind: 'ent',
      authority: 'pinakes',
      confidence: 1,
      world: ALDERFOREST,
      sameAs: ['analyzer:ent:e-8842'],
      basedOn: ['pinakes:ent:napoleon-i'],
      provenance: [
        {
          agent: 'pinakes:agent:resolver',
          activity: 'analyzer:src:run-1a2b',
          asserted: '2026-07-18T06:20:00Z',
        },
      ],
      attachedAssets: ['analyzer:asset:sha256-aa11'],
    });
    // The firewall in one assertion: Wikidata's Napoleon is two `same_as` hops away, but
    // the second hop is only reachable *through* the `based_on`. Traversing it would make
    // every fact about the real Napoleon a fact about the fictional general (§4.3).
    expect(resolved.sameAs).not.toContain('wikidata:ent:q517');
  });

  it('walks same_as in both directions and transitively', async () => {
    const { fetch } = authority({
      '/resolve/': {
        body: {
          links: [
            { subject: 'analyzer:ent:e-8842', relation: 'same_as', object: 'pinakes:ent:napoleon-i' },
            { subject: 'pinakes:ent:napoleon-i', relation: 'same_as', object: 'wikidata:ent:q517' },
          ],
        },
      },
    });
    const resolved = await createPinakesResolver({ endpoint: ENDPOINT, fetch }).resolve({
      id: 'analyzer:ent:e-8842',
    });
    // §4.2: facts flow *both ways* across `same_as`, so the closure is undirected.
    expect(resolved.sameAs.sort()).toEqual(['pinakes:ent:napoleon-i', 'wikidata:ent:q517']);
    expect(resolved.basedOn).toEqual([]);
  });

  it('reads a precomputed closure when the authority sends one instead of links', async () => {
    const { fetch } = authority({
      '/resolve/': {
        body: {
          entity: { id: 'pinakes:ent:napoleon-i' },
          same_as_closure: [{ id: 'wikidata:ent:q517' }],
          based_on: ['insimul:world:alderforest:ent:npc-renaud'],
        },
      },
    });
    const resolved = await createPinakesResolver({ endpoint: ENDPOINT, fetch }).resolve({
      id: 'pinakes:ent:napoleon-i',
    });
    expect(resolved.sameAs).toEqual(['wikidata:ent:q517']);
    expect(resolved.basedOn).toEqual(['insimul:world:alderforest:ent:npc-renaud']);
  });

  it('does not dial for ids that never round-trip to an authority (§6)', async () => {
    const { fetch, calls } = authority({});
    const resolver = createPinakesResolver({ endpoint: ENDPOINT, fetch });

    for (const id of [
      'insimul:claim:sha256-9f3c1a',
      'analyzer:asset:sha256-aa11',
      'agora:agent:provider-router',
    ]) {
      await expect(resolver.resolve({ id })).resolves.toMatchObject({ id, authority: 'local' });
    }
    // Claims and assets are content hashes and agents are nobody's real-world entity, so
    // asking Pinakes about them is a request that could only ever be answered "yes, that id".
    expect(calls).toEqual([]);
  });

  it('answers locally when the authority has never heard of the id', async () => {
    const { fetch } = authority({ '/resolve/': { status: 404, body: { detail: 'unknown' } } });
    // A provisional local (§6) is valid before anyone reconciles it — 404 is the normal
    // state of a freshly minted id, not an error.
    await expect(
      createPinakesResolver({ endpoint: ENDPOINT, fetch }).resolve({ id: 'analyzer:ent:e-8842' }),
    ).resolves.toMatchObject({ authority: 'local', sameAs: [], basedOn: [] });
  });

  it('refuses a bare name — that is what reconcile is for', async () => {
    const { fetch } = authority({});
    await expect(
      createPinakesResolver({ endpoint: ENDPOINT, fetch }).resolve({ name: 'Napoleon' }),
    ).rejects.toThrow(/reconcile/);
  });
});

describe('offline (§8: a local cache that syncs opportunistically)', () => {
  it('replays the last authority answer, labelled cache rather than pinakes', async () => {
    const cache = createMemoryCache();
    const online = authority({ '/resolve/': { body: EQUIVALENCE_LAYER } });
    const fresh = await createPinakesResolver({
      endpoint: ENDPOINT,
      fetch: online.fetch,
      cache,
    }).resolve({ id: RENAUD });

    const offline: AuthorityFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const replayed = await createPinakesResolver({ endpoint: ENDPOINT, fetch: offline, cache })
      .resolve({ id: RENAUD });

    expect(replayed).toEqual({ ...fresh, authority: 'cache' });
    // The distinction is load-bearing: "Pinakes says so" licenses a write-back, "Pinakes
    // said so once" does not.
    expect(fresh.authority).toBe('pinakes');
  });

  it('falls back to the cache when the authority errors, not only when it is down', async () => {
    const cache = createMemoryCache();
    const online = authority({ '/resolve/': { body: EQUIVALENCE_LAYER } });
    await createPinakesResolver({ endpoint: ENDPOINT, fetch: online.fetch, cache }).resolve({
      id: RENAUD,
    });
    const broken = authority({ '/resolve/': { status: 503, body: { detail: 'down for QA' } } });
    await expect(
      createPinakesResolver({ endpoint: ENDPOINT, fetch: broken.fetch, cache }).resolve({
        id: RENAUD,
      }),
    ).resolves.toMatchObject({ authority: 'cache' });
  });

  it('says so plainly when the authority is unreachable and the cache is cold', async () => {
    const offline: AuthorityFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      createPinakesResolver({ endpoint: ENDPOINT, fetch: offline }).resolve({ id: 'analyzer:ent:e-8842' }),
    ).rejects.toThrow(AuthorityUnreachableError);
  });
});

describe('reconcile in the OpenRefine shape (§4.5)', () => {
  const CANDIDATES = {
    q0: {
      result: [
        { id: 'pinakes:ent:napoleon-i', name: 'Napoleon I', score: 83, match: false, type: [{ id: 'wikidata:ent:q5' }] },
        { id: 'pinakes:ent:napoleon-iii', name: 'Napoleon III', score: 41, match: false, type: [] },
      ],
    },
  };

  it('sends the standard query and queues a below-threshold cross-world match', async () => {
    const { fetch, calls } = authority({
      '/reconcile': { body: CANDIDATES },
      '/resolve/': { status: 404 },
    });
    const resolver = createPinakesResolver({ endpoint: ENDPOINT, fetch });
    const result = await resolver.reconcile({
      query: 'Renaud',
      type: 'wikidata:ent:q5',
      limit: 5,
      of: 'analyzer:ent:e-8842',
      world: ALDERFOREST,
    });

    expect(calls).toContain(`POST ${ENDPOINT}/reconcile`);
    expect(result.candidates[0]).toMatchObject({
      id: 'pinakes:ent:napoleon-i',
      confidence: 0.83,
      world: REALITY,
      types: ['wikidata:ent:q5'],
    });
    // Cross-world, so lineage; 0.83 is under the 0.9 threshold, so queued rather than
    // applied — the hybrid policy (§11 decision 2) in one result.
    expect(result.proposal).toMatchObject({
      relation: 'based_on',
      subject: 'analyzer:ent:e-8842',
      object: 'pinakes:ent:napoleon-i',
      review: true,
    });
    expect(resolver.reviewQueue).toEqual([result.proposal]);
    expect(resolver.applied).toEqual([]);
  });

  it('auto-applies a same-world match that clears the threshold', async () => {
    const { fetch } = authority({
      '/reconcile': {
        body: { result: [{ id: `${ALDERFOREST}:ent:npc-renaud`, name: 'Renaud', score: 96 }] },
      },
      '/resolve/': { status: 404 },
    });
    const resolver = createPinakesResolver({ endpoint: ENDPOINT, fetch });
    const result = await resolver.reconcile({ query: 'Renaud', of: 'analyzer:ent:e-8842', world: ALDERFOREST });

    expect(result.proposal).toMatchObject({ relation: 'same_as', review: false });
    expect(resolver.applied).toEqual([result.proposal]);
    expect(resolver.reviewQueue).toEqual([]);
  });

  it('will not promote a candidate it already knows is only lineage', async () => {
    const { fetch } = authority({
      '/resolve/': { body: EQUIVALENCE_LAYER },
      '/reconcile': {
        body: { result: [{ id: 'pinakes:ent:napoleon-i', name: 'Napoleon I', score: 99 }] },
      },
    });
    const resolver = createPinakesResolver({ endpoint: ENDPOINT, fetch });
    // The caller asserts the real world and the match is all but certain — and the resolver
    // still refuses, because resolving the subject shows the candidate is already reached
    // through `based_on` (§4.5, final paragraph).
    const result = await resolver.reconcile({ query: 'Napoleon', of: RENAUD, world: REALITY });

    expect(result.proposal).toMatchObject({ relation: 'based_on', review: false });
    expect(result.proposal.why).toMatch(/based_on chain/);
  });

  it('has nothing to replay when the authority is down — matching is a judgement', async () => {
    const offline: AuthorityFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      createPinakesResolver({ endpoint: ENDPOINT, fetch: offline }).reconcile({ query: 'Napoleon' }),
    ).rejects.toThrow(AuthorityUnreachableError);
  });
});

describe('reading the reconciliation response', () => {
  const policy = mergePolicy();

  it('ranks by confidence whatever order the service used', () => {
    const candidates = readCandidates(
      { result: [{ id: 'pinakes:ent:b', score: 40 }, { id: 'pinakes:ent:a', score: 90 }] },
      policy,
    );
    expect(candidates.map((entry) => entry.id)).toEqual(['pinakes:ent:a', 'pinakes:ent:b']);
  });

  it('reads a 0–100 score as a percentage and a 0–1 score as itself', () => {
    const [percent] = readCandidates([{ id: 'pinakes:ent:a', score: 83 }], policy);
    const [unit] = readCandidates([{ id: 'pinakes:ent:b', score: 0.83 }], policy);
    // Reading 83 as a confidence of 83 would clear every threshold there is.
    expect(percent?.confidence).toBe(0.83);
    expect(unit?.confidence).toBe(0.83);
  });

  it('ignores entries that name no id', () => {
    expect(readCandidates({ result: [{ name: 'Napoleon', score: 99 }] }, policy)).toEqual([]);
  });
});
