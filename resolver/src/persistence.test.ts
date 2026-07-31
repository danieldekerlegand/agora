import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileCache,
  createFileLinkStore,
  createResolverServer,
  type AuthorityResolver,
  type AuthorityFetch,
  type AuthorityResponse,
  type LinkProposal,
  type ResolvedIdentity,
  type ResolverService,
} from './index.ts';

const ALDERFOREST = 'worldsim:world:alderforest';
const RENAUD = `${ALDERFOREST}:ent:npc-renaud`;
const ANALYZER = 'analyzer:ent:e-8842';
const NAPOLEON = 'refkb:ent:napoleon-i';
const ENDPOINT = 'https://refkb.example/resolver';

/** The §4.3 worked case: `analyzer` is the same as `renaud`, which is *based on* Napoleon. */
const EQUIVALENCE_LAYER = {
  entity: { id: RENAUD, kind: 'ent' },
  links: [
    { subject: ANALYZER, relation: 'same_as', object: RENAUD },
    { subject: RENAUD, relation: 'based_on', object: NAPOLEON },
  ],
};

const dirs: string[] = [];
function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agora-resolver-'));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ok(body: unknown): Promise<AuthorityResponse> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
const notFound: AuthorityResponse = { ok: false, status: 404, json: () => Promise.resolve({}) };

/**
 * A stubbed authority. `resolve` of the ent answers the equivalence layer (so it caches);
 * anything else is a 404 (a provisional local, §6). `reconcile` answers a same-world hit for
 * "Renaud" (auto-applied `same_as`) and a below-threshold cross-world hit for "Napoleon"
 * (a queued `based_on`) — one of each half of the merge policy (§11 decision 2).
 */
function liveAuthority(): AuthorityFetch {
  return (url, init) => {
    if (url.includes('/reconcile')) {
      const body = JSON.parse(init?.body ?? '{}') as { queries: { q0: { query: string } } };
      const query = body.queries.q0.query;
      const result =
        query === 'Renaud'
          ? [{ id: RENAUD, name: 'Renaud', score: 96 }]
          : [{ id: NAPOLEON, name: 'Napoleon I', score: 83 }];
      return ok({ q0: { result } });
    }
    if (url.includes('npc-renaud')) return ok(EQUIVALENCE_LAYER);
    return Promise.resolve(notFound);
  };
}

const downAuthority: AuthorityFetch = () => Promise.reject(new Error('authority down'));

describe('the durable resolver cache (§8: offline replay as authority:cache)', () => {
  it('replays a persisted authority answer after a restart with the authority unreachable', async () => {
    const cachePath = tmpFile('cache.json');
    const linksPath = tmpFile('links.json');

    // A live run: resolve caches, and the two reconciles fill both halves of the policy.
    let service: ResolverService = createResolverServer({
      authority: ENDPOINT,
      fetch: liveAuthority(),
      cache: createFileCache(cachePath),
      links: createFileLinkStore(linksPath),
    });
    let addr = await service.listen();
    let base = `http://${addr.host}:${addr.port}`;

    const live = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(RENAUD)}`)
    ).json()) as ResolvedIdentity;
    expect(live.authority).toBe('authority');

    const applied = (await (
      await fetch(`${base}/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Renaud', of: ANALYZER, world: ALDERFOREST }),
      })
    ).json()) as { proposal: LinkProposal };
    expect(applied.proposal).toMatchObject({ relation: 'same_as', review: false });

    const queued = (await (
      await fetch(`${base}/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Napoleon', of: ANALYZER, world: ALDERFOREST }),
      })
    ).json()) as { proposal: LinkProposal };
    expect(queued.proposal).toMatchObject({ relation: 'based_on', review: true });

    await service.close();

    // Restart against the SAME store paths, authority now unreachable.
    service = createResolverServer({
      authority: ENDPOINT,
      fetch: downAuthority,
      cache: createFileCache(cachePath),
      links: createFileLinkStore(linksPath),
    });
    addr = await service.listen();
    base = `http://${addr.host}:${addr.port}`;

    const offline = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(RENAUD)}`)
    ).json()) as ResolvedIdentity;
    // The cached view replays — never relabelled 'authority' (§8, §11 decision 1).
    expect(offline.authority).toBe('cache');
    expect(offline.id).toBe(RENAUD);
    expect(offline.sameAs).toEqual([ANALYZER]);
    expect(offline.basedOn).toEqual([NAPOLEON]);

    // Both halves of the equivalence layer survived the restart.
    const resolver = service.resolver as AuthorityResolver;
    expect(resolver.applied).toHaveLength(1);
    expect(resolver.applied[0]).toMatchObject({ relation: 'same_as', object: RENAUD });
    expect(resolver.reviewQueue).toHaveLength(1);
    expect(resolver.reviewQueue[0]).toMatchObject({ relation: 'based_on', object: NAPOLEON });

    await service.close();
  });

  it('surfaces AuthorityUnreachableError as a 502 for an id that was never cached', async () => {
    const service = createResolverServer({
      authority: ENDPOINT,
      fetch: downAuthority,
      cache: createFileCache(tmpFile('cache.json')),
    });
    const addr = await service.listen();
    const base = `http://${addr.host}:${addr.port}`;
    const response = await fetch(`${base}/resolve?id=${encodeURIComponent(NAPOLEON)}`);
    expect(response.status).toBe(502);
    await service.close();
  });
});

describe('the firewall holds through persistence (§4.3)', () => {
  it('recomputes the same_as closure on read, so a persisted based_on edge never leaks', () => {
    const cachePath = tmpFile('cache.json');
    const record: ResolvedIdentity = {
      id: RENAUD,
      kind: 'ent',
      authority: 'authority',
      confidence: 1,
      world: ALDERFOREST,
      sameAs: [ANALYZER],
      basedOn: [NAPOLEON],
      provenance: [],
      attachedAssets: [],
    };
    createFileCache(cachePath).set(RENAUD, record);

    // A fresh store reads the same file — the closure is recomputed by closureOver at read.
    const reloaded = createFileCache(cachePath).get(RENAUD);
    expect(reloaded).toBeDefined();
    expect(reloaded?.sameAs).toEqual([ANALYZER]);
    expect(reloaded?.basedOn).toEqual([NAPOLEON]);
    // The load-bearing assertion: lineage stays lineage across the round trip. A based_on id
    // is never walked into the same_as set (§4.3).
    expect(reloaded?.sameAs).not.toContain(NAPOLEON);
  });
});

describe('the durable equivalence-layer store (§11 decision 2)', () => {
  it('rehydrates both the applied and the queued lists after a restart', () => {
    const path = tmpFile('links.json');
    const appliedLink: LinkProposal = {
      relation: 'same_as',
      subject: ANALYZER,
      object: RENAUD,
      confidence: 0.96,
      review: false,
      why: 'same world',
    };
    const queuedLink: LinkProposal = {
      relation: 'based_on',
      subject: ANALYZER,
      object: NAPOLEON,
      confidence: 0.83,
      review: true,
      why: 'cross-world, below threshold',
    };

    const store = createFileLinkStore(path);
    store.addApplied(appliedLink);
    store.addReview(queuedLink);

    const reloaded = createFileLinkStore(path);
    expect(reloaded.loadApplied()).toEqual([appliedLink]);
    expect(reloaded.loadReviewQueue()).toEqual([queuedLink]);
  });

  it('is an empty pair of lists when no file exists yet', () => {
    const store = createFileLinkStore(tmpFile('links.json'));
    expect(store.loadApplied()).toEqual([]);
    expect(store.loadReviewQueue()).toEqual([]);
  });
});
