import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createResolverServer,
  RESOLVER_IDENTITY,
  type ResolvedIdentity,
  type ResolverDescription,
  type ResolverService,
} from './index.ts';

/**
 * The HTTP surface is the same {@link Resolver} over the wire: these boot a real server on an
 * ephemeral port and speak to it with `fetch`, mirroring `index.test.ts`'s in-process
 * assertions — identity carried, never a payload; a well-formed id resolves locally; the
 * refusals stay loud (a name, a reconcile) as 4xx; and no /invoke relay route exists.
 */
describe('the resolver HTTP service (identity only, never a payload)', () => {
  let service: ResolverService;
  let base: string;

  beforeEach(async () => {
    service = createResolverServer();
    const { host, port } = await service.listen();
    base = `http://${host}:${port}`;
  });

  afterEach(() => service.close());

  it('reports its identity, KINP version and the two §8 verbs at the description route', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const description = (await response.json()) as ResolverDescription;
    expect(description.identity).toBe(RESOLVER_IDENTITY);
    expect(description.identity).toBe('agora:agent:resolver');
    expect(description.verbs).toEqual(['resolve', 'reconcile']);
    expect(description.verbs).not.toContain('invoke');
  });

  it('resolves a well-formed KINP id to itself with authority:local', async () => {
    const response = await fetch(`${base}/resolve?id=agora:agent:provider-router`);
    expect(response.status).toBe(200);
    const resolved = (await response.json()) as ResolvedIdentity;
    expect(resolved).toEqual({
      id: 'agora:agent:provider-router',
      kind: 'agent',
      authority: 'local',
      confidence: 1,
      sameAs: [],
      basedOn: [],
      provenance: [],
      attachedAssets: [],
    });
  });

  it('reads kind and world out of a world-scoped ent id (§5)', async () => {
    const id = 'insimul:world:alderforest:ent:npc-renaud';
    const response = await fetch(`${base}/resolve?id=${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    const resolved = (await response.json()) as ResolvedIdentity;
    expect(resolved.kind).toBe('ent');
    expect(resolved.world).toBe('insimul:world:alderforest');
    // No authority is configured, yet a well-formed id still answers — degraded, not broken.
    expect(resolved.authority).toBe('local');
  });

  it('refuses to invent an identity for a name — a 4xx, never a guessed id', async () => {
    const response = await fetch(`${base}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Napoleon I' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('ResolverUnavailableError');
  });

  it('refuses to reconcile without an authority — a 4xx, equivalence is the authority’s', async () => {
    const response = await fetch(`${base}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Napoleon' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('ResolverUnavailableError');
  });

  it('rejects a reconcile with no descriptor as a 4xx bad request', async () => {
    const response = await fetch(`${base}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ent' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('BadRequest');
  });

  it('has no invoke/link/forward route — an unknown path is a 404, not a relay', async () => {
    for (const path of ['/invoke', '/link', '/forward']) {
      const posted = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      expect(posted.status).toBe(404);
      const got = await fetch(`${base}${path}`);
      expect(got.status).toBe(404);
    }
  });
});

describe('the resolver HTTP service dialing an authority', () => {
  let service: ResolverService;
  let base: string;

  afterEach(() => service.close());

  it('replays the cache labelled authority:cache when the authority is unreachable', async () => {
    const id = 'insimul:world:alderforest:ent:npc-renaud';
    let up = true;
    // A stubbed authority that answers once, then goes dark — the cache must carry the answer.
    service = createResolverServer({
      authority: 'https://pinakes.example/resolver',
      fetch: () => {
        if (!up) return Promise.reject(new Error('authority down'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ entity: { id, kind: 'ent' } }),
        });
      },
    });
    const address = await service.listen();
    base = `http://${address.host}:${address.port}`;

    const live = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(id)}`)
    ).json()) as ResolvedIdentity;
    expect(live.authority).toBe('pinakes');

    up = false;
    const offline = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(id)}`)
    ).json()) as ResolvedIdentity;
    // Never relabelled 'pinakes' — a replay is a replay (§8, §11 decision 1).
    expect(offline.authority).toBe('cache');
    expect(offline.id).toBe(id);
  });

  it('surfaces AuthorityUnreachableError as a 502 when nothing is cached', async () => {
    service = createResolverServer({
      authority: 'https://pinakes.example/resolver',
      fetch: () => Promise.reject(new Error('authority down')),
    });
    const address = await service.listen();
    base = `http://${address.host}:${address.port}`;

    const response = await fetch(
      `${base}/resolve?id=${encodeURIComponent('pinakes:ent:napoleon-i')}`,
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('AuthorityUnreachableError');
  });
});
