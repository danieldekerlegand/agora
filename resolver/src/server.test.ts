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
    const id = 'worldsim:world:alderforest:ent:npc-renaud';
    const response = await fetch(`${base}/resolve?id=${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    const resolved = (await response.json()) as ResolvedIdentity;
    expect(resolved.kind).toBe('ent');
    expect(resolved.world).toBe('worldsim:world:alderforest');
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

describe('the grounding-pack ingest surface over the wire (KGP §2)', () => {
  let service: ResolverService;
  let base: string;

  const LOCAL = 'herbarium:local:ent:e-8842';
  const CANONICAL = 'refkb:ent:napoleon-i';

  function pack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kgp_version: '0.4.0',
      pack_id: `sha256-${'a'.repeat(64)}`,
      producer: 'herbarium',
      worlds: ['refkb:world:consensus-reality'],
      kind: 'snapshot',
      basis: null,
      dialect: 'grounding-only',
      entities: [],
      assertions: [],
      links: [
        {
          id: 'herbarium:claim:x',
          relation: 'same_as',
          args: [LOCAL, CANONICAL],
          world: 'refkb:world:consensus-reality',
          confidence: 0.98,
          provenance: { source: 'herbarium', confidence: 0.98 },
          license: 'CC-BY-4.0',
        },
      ],
      provenance: [],
      manifest: { counts: {}, created: '2026-08-06T00:00:00.000Z', license_policy: {} },
      ...overrides,
    };
  }

  function post(body: unknown): Promise<Response> {
    return fetch(`${base}/grounding-packs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    service = createResolverServer();
    const { host, port } = await service.listen();
    base = `http://${host}:${port}`;
  });

  afterEach(() => service.close());

  it('declares the pack contract it accepts alongside the §8 verbs', async () => {
    const description = (await (await fetch(`${base}/`)).json()) as ResolverDescription;
    expect(description.ingests).toEqual(['grounding-pack']);
    // Ingest is not a fourth identity verb — §8 names two the service serves, and that list
    // is what a caller reads to know it is not being offered a transform gateway.
    expect(description.verbs).toEqual(['resolve', 'reconcile']);
  });

  it('ingests a pack and answers the merged view over its same_as edges, computed per call', async () => {
    const ingested = await post(pack());
    expect(ingested.status).toBe(200);
    expect(await ingested.json()).toMatchObject({ producer: 'herbarium', entities: 0 });

    const resolved = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(LOCAL)}`)
    ).json()) as ResolvedIdentity;
    expect(resolved.sameAs).toEqual([CANONICAL]);
    // A pack we hold is knowledge we hold: it never promotes an answer to the authority's.
    expect(resolved.authority).toBe('local');
  });

  it('refuses a pack carrying local-only content with a 4xx and the violations (§7.2)', async () => {
    const refused = await post(
      pack({
        entities: [
          {
            csid: CANONICAL,
            entityType: 'person',
            fields: { name: 'Napoleon I' },
            provenance: { source: 'herbarium', confidence: 1 },
            license: 'CC-BY-4.0',
            egress: 'local-only',
          },
        ],
      }),
    );
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      error: string;
      code: string;
      violations: unknown[];
    };
    expect(body.error).toBe('GroundingPackError');
    expect(body.code).toBe('local-only');
    expect(body.violations).toHaveLength(1);
    // Refused whole: nothing from the pack entered the equivalence layer.
    const resolved = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(LOCAL)}`)
    ).json()) as ResolvedIdentity;
    expect(resolved.sameAs).toEqual([]);
  });

  it('refuses a pack whose dialect exceeds what it evaluates, by code (§5)', async () => {
    const refused = await post(pack({ dialect: 'full-prolog' }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('dialect-exceeded');
  });

  it('serves the ingest surface on POST only — a GET is still a 404, not a listing', async () => {
    expect((await fetch(`${base}/grounding-packs`)).status).toBe(404);
  });
});

describe('the resolver HTTP service dialing an authority', () => {
  let service: ResolverService;
  let base: string;

  afterEach(() => service.close());

  it('replays the cache labelled authority:cache when the authority is unreachable', async () => {
    const id = 'worldsim:world:alderforest:ent:npc-renaud';
    let up = true;
    // A stubbed authority that answers once, then goes dark — the cache must carry the answer.
    service = createResolverServer({
      authority: 'https://refkb.example/resolver',
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
    expect(live.authority).toBe('authority');

    up = false;
    const offline = (await (
      await fetch(`${base}/resolve?id=${encodeURIComponent(id)}`)
    ).json()) as ResolvedIdentity;
    // Never relabelled 'authority' — a replay is a replay (§8, §11 decision 1).
    expect(offline.authority).toBe('cache');
    expect(offline.id).toBe(id);
  });

  it('surfaces AuthorityUnreachableError as a 502 when nothing is cached', async () => {
    service = createResolverServer({
      authority: 'https://refkb.example/resolver',
      fetch: () => Promise.reject(new Error('authority down')),
    });
    const address = await service.listen();
    base = `http://${address.host}:${address.port}`;

    const response = await fetch(
      `${base}/resolve?id=${encodeURIComponent('refkb:ent:napoleon-i')}`,
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('AuthorityUnreachableError');
  });
});
