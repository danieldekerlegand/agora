import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startResolver, type ResolvedIdentity, type StartedResolver } from './index.ts';

/**
 * The resolver's slice of the composed run (US-6): boot the real entry point against a live
 * authority, resolve an ent id (authority:'authority', cache populated), then restart the same
 * entry point with the authority gone — the durable cache replays the answer as
 * authority:'cache', never 'authority' (§8, §11 decision 1). The same_as/based_on firewall
 * holds through the round-trip: the persisted based_on edge never leaks into the same_as
 * closure recomputed on reload (§4.3).
 */
describe('cross-service: the resolver replays its durable cache offline', () => {
  const ENT_ID = 'worldsim:world:alderforest:ent:npc-renaud';
  const SAME_AS = 'worldsim:world:alderforest:ent:renaud-the-elder';
  const BASED_ON = 'refkb:ent:napoleon';

  const started: StartedResolver[] = [];
  const authorities: Server[] = [];
  let dir: string;

  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.service.close()));
    await Promise.all(
      authorities.splice(0).map((a) => new Promise<void>((r) => a.close(() => r()))),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal §8-shaped authority: answers §8's resolve body for the one ent id. */
  function bootAuthority(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/resolve/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ same_as: [SAME_AS], based_on: [BASED_ON] }));
        return;
      }
      res.writeHead(404).end();
    });
    authorities.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  async function bootResolver(env: Record<string, string | undefined>): Promise<string> {
    const start = await startResolver({ AGORA_RESOLVER_PORT: '0', ...env });
    started.push(start);
    return `http://${start.host}:${start.port}`;
  }

  it('populates the cache online, then replays it as authority:cache after an offline restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-resolver-integration-'));
    const cachePath = join(dir, 'cache.json');
    const linksPath = join(dir, 'links.json');

    // Online: dial the live authority, get its answer, and populate the durable cache.
    const authority = await bootAuthority();
    const onlineBase = await bootResolver({
      AGORA_RESOLVER_AUTHORITY: authority,
      AGORA_RESOLVER_CACHE: cachePath,
      AGORA_RESOLVER_LINKS: linksPath,
    });
    const live = (await (
      await fetch(`${onlineBase}/resolve?id=${encodeURIComponent(ENT_ID)}`)
    ).json()) as ResolvedIdentity;
    expect(live.authority).toBe('authority');
    expect(live.sameAs).toContain(SAME_AS);
    expect(live.basedOn).toContain(BASED_ON);

    // Tear the whole world down: the resolver process AND the authority are gone.
    await Promise.all(started.splice(0).map((s) => s.service.close()));
    await Promise.all(
      authorities.splice(0).map((a) => new Promise<void>((r) => a.close(() => r()))),
    );

    // Offline restart against the same cache path, authority now unreachable.
    const offlineBase = await bootResolver({
      AGORA_RESOLVER_AUTHORITY: authority,
      AGORA_RESOLVER_CACHE: cachePath,
      AGORA_RESOLVER_LINKS: linksPath,
    });
    const replayed = (await (
      await fetch(`${offlineBase}/resolve?id=${encodeURIComponent(ENT_ID)}`)
    ).json()) as ResolvedIdentity;

    // Replayed from cache, labelled 'cache' — never relabelled 'authority'.
    expect(replayed.authority).toBe('cache');
    expect(replayed.id).toBe(ENT_ID);
    // The firewall survived the disk round-trip: based_on stays out of the same_as closure.
    expect(replayed.sameAs).toContain(SAME_AS);
    expect(replayed.basedOn).toContain(BASED_ON);
    expect(replayed.sameAs).not.toContain(BASED_ON);
  });
});
