/**
 * The bridge end to end, over real HTTP, driven by a producer this ecosystem has never heard of.
 *
 * Nothing is stubbed that would hide the point: the vocabulary is koine's real registry loaded
 * through the SDK's own `indexRegistry`, the consumer is a second HTTP server discovered from its
 * KCB manifest, and the producer is a herbarium cataloguing plant specimens — a caller with no
 * relationship to anything in this tree. If any producer-specific knowledge had crept into the
 * bridge, this file would not pass.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseRegistry, parseVocabulary, type CapabilityManifest } from '@agora/schemas';
import { KOINE_PREDICATE_MAPPING, KOINE_VOCABULARY } from '@agora/schemas/fixtures';
import { validate } from '@agora/schemas/validator';
import { indexRegistry, SPEC_VERSIONS } from '@agora/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { Claim } from './claim.ts';
import { consumerFromManifest, ConsumerError } from './consumer.ts';
import type { GroundingPack } from './pack.ts';
import { createSyncServer, describeKnowledgeSync, type SyncService } from './server.ts';
import type { SyncReceipt } from './sync.ts';

/** koine's registry, loaded the way a deployment loads it: validated, then indexed by the SDK. */
const REGISTRY = indexRegistry({
  document: parseRegistry(KOINE_PREDICATE_MAPPING),
  relations: parseVocabulary(KOINE_VOCABULARY),
});

/** A KGP consumer on the wire: it accepts packs, keeps them, and can be told to refuse. */
interface FakeConsumer {
  readonly server: Server;
  readonly manifest: CapabilityManifest;
  readonly received: GroundingPack[];
  refuse: string | undefined;
}

async function startConsumer(): Promise<FakeConsumer> {
  const received: GroundingPack[] = [];
  const state: { refuse: string | undefined } = { refuse: undefined };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url !== '/kgp/packs' || req.method !== 'POST') {
        res.writeHead(404).end('no such route');
        return;
      }
      if (state.refuse !== undefined) {
        res.writeHead(422, { 'content-type': 'text/plain' }).end(state.refuse);
        return;
      }
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as GroundingPack);
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  const manifest: CapabilityManifest = {
    kcb_version: SPEC_VERSIONS.kcb,
    identity: 'pinakes:agent:authority',
    endpoints: { a2a: base },
    capabilities: [
      {
        name: 'knowledge.ingest',
        inputs: [{ plane: 'knowledge', dialect: 'grounding-only', shape: 'kgp-pack' }],
        endpoint: `${base}/kgp/packs`,
      },
    ],
  };
  return {
    server,
    manifest,
    received,
    get refuse() {
      return state.refuse;
    },
    set refuse(value: string | undefined) {
      state.refuse = value;
    },
  };
}

const open: { consumer: FakeConsumer | undefined; bridge: SyncService | undefined } = {
  consumer: undefined,
  bridge: undefined,
};

afterEach(async () => {
  await open.bridge?.close();
  if (open.consumer) await new Promise((resolve) => open.consumer?.server.close(resolve));
  open.bridge = undefined;
  open.consumer = undefined;
});

/** Boot a consumer and a bridge pointed at it, wired only through the consumer's manifest. */
async function bridgeTo(consumer: FakeConsumer): Promise<string> {
  const bridge = createSyncServer({
    consumer: consumerFromManifest(consumer.manifest),
    relations: (relation) => REGISTRY.relation(relation),
    egressOfRelation: REGISTRY.egressFor('herbarium'),
    now: () => '2026-08-06T00:00:00.000Z',
  });
  const address = await bridge.listen();
  open.bridge = bridge;
  return `http://${address.host}:${String(address.port)}`;
}

/** The synthetic producer's batch: two admissible claims and one it may not export. */
const CLAIMS: readonly Claim[] = [
  {
    world: 'herbarium:world:consensus-reality',
    relation: 'same_as',
    args: ['herbarium:ent:specimen-14821', 'cs:taxon:Q157211'],
    confidence: 0.94,
    license: 'CC-BY-4.0',
    prov: { source: 'herbarium', confidence: 0.94 },
  },
  {
    world: 'herbarium:world:consensus-reality',
    relation: 'co_occurs',
    args: ['herbarium:ent:specimen-14821', 'herbarium:ent:specimen-14822'],
    license: 'CC0-1.0',
    prov: { source: 'herbarium', confidence: 0.7 },
  },
  {
    world: 'herbarium:world:consensus-reality',
    relation: 'same_as',
    args: ['herbarium:ent:collector-jrs', 'cs:person:local-volunteer'],
    license: 'PERSONAL',
    egress: 'local-only',
    prov: { source: 'herbarium', confidence: 1 },
  },
];

async function submit(base: string, body: unknown): Promise<{ status: number; receipt: SyncReceipt }> {
  const response = await fetch(`${base}/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, receipt: (await response.json()) as SyncReceipt };
}

describe('the KGP sync surface, producer to consumer', () => {
  it('admits an arbitrary producer\'s claims and delivers them to the discovered consumer', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const { status, receipt } = await submit(base, { producer: 'herbarium', claims: CLAIMS });

    expect(status).toBe(200);
    expect(receipt.delivered).toBe(true);
    expect(receipt.consumer).toBe('pinakes:agent:authority');
    expect(receipt.accepted).toHaveLength(2);
    expect(receipt.pack_id).toMatch(/^sha256-[0-9a-f]{64}$/);

    // The consumer received a conformant KGP pack, and only what was admitted.
    expect(consumer.received).toHaveLength(1);
    const pack = consumer.received[0] as GroundingPack;
    expect(validate('grounding-pack', pack)).toEqual([]);
    expect(pack.producer).toBe('herbarium');
    expect(pack.pack_id).toBe(receipt.pack_id);
    expect([...pack.assertions, ...pack.links].map((record) => record.relation).sort()).toEqual([
      'co_occurs',
      'same_as',
    ]);
  });

  it('withholds the local-only record and reports it rather than dropping it (§7.2)', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const { receipt } = await submit(base, { producer: 'herbarium', claims: CLAIMS });

    expect(receipt.rejected.map((r) => r.code)).toEqual(['local-only']);
    expect(receipt.rejected[0]?.index).toBe(2);
    const pack = consumer.received[0] as GroundingPack;
    const delivered = [...pack.assertions, ...pack.links].map((record) => record.hash_input);
    expect(delivered.some((input) => input.includes('collector-jrs'))).toBe(false);
  });

  it('refuses a relation the shared registry does not publish, and delivers the rest', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const invented: Claim = {
      world: 'herbarium:world:consensus-reality',
      relation: 'pressed_between',
      args: ['herbarium:ent:specimen-14821', 'herbarium:ent:folio-3'],
      license: 'CC0-1.0',
      prov: { source: 'herbarium', confidence: 1 },
    };
    const { receipt } = await submit(base, {
      producer: 'herbarium',
      claims: [CLAIMS[0], invented],
    });

    expect(receipt.accepted).toHaveLength(1);
    expect(receipt.rejected[0]?.code).toBe('unknown-relation');
    expect(receipt.rejected[0]?.reason).toMatch(/relations\.tsv/);
  });

  it('delivers nothing when nothing was admitted, and says so with reasons', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const { status, receipt } = await submit(base, {
      producer: 'herbarium',
      claims: [{ ...(CLAIMS[0] as Claim), license: 'PROPRIETARY' }],
    });

    expect(status).toBe(200);
    expect(receipt.delivered).toBe(false);
    expect(receipt.pack_id).toBeUndefined();
    expect(receipt.rejected[0]?.code).toBe('license-refused');
    expect(consumer.received).toEqual([]);
  });

  it('reports a consumer that refused the pack as an upstream failure, in its own words', async () => {
    const consumer = (open.consumer = await startConsumer());
    consumer.refuse = 'pack rejected: world not subscribed';
    const base = await bridgeTo(consumer);

    const { status, receipt } = await submit(base, { producer: 'herbarium', claims: CLAIMS });

    expect(status).toBe(502);
    expect(receipt.delivered).toBe(false);
    expect(receipt.detail).toBe('pack rejected: world not subscribed');
  });

  it('rejects a submission that is not one, without touching the consumer', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const bad = await submit(base, { claims: [] });
    expect(bad.status).toBe(400);
    const malformed = await submit(base, {
      producer: 'herbarium',
      claims: [{ world: 'herbarium:world:consensus-reality', relation: 'same_as', args: 'nope' }],
    });
    expect(malformed.status).toBe(400);
    expect(consumer.received).toEqual([]);
  });

  it('answers /describe with the invariants, and 404s anything that would make it a store', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const described = (await (await fetch(`${base}/describe`)).json()) as ReturnType<
      typeof describeKnowledgeSync
    >;
    expect(described).toEqual(describeKnowledgeSync());
    expect(described.retainsClaims).toBe(false);
    expect(described.coinsRelations).toBe(false);
    expect((await fetch(`${base}/query`)).status).toBe(404);
  });
});

describe('the bridge is agnostic to who produced the claims', () => {
  it('mints the same claim id for the same fact from two unrelated producers (§3.3)', async () => {
    const consumer = (open.consumer = await startConsumer());
    const base = await bridgeTo(consumer);

    const fact: Claim = {
      world: 'refkb:world:consensus-reality',
      relation: 'same_as',
      args: ['cs:taxon:Q157211', 'wikidata:ent:Q157211'],
      license: 'CC0-1.0',
      prov: { source: 'herbarium', confidence: 0.8 },
    };
    const first = await submit(base, { producer: 'herbarium', claims: [fact] });
    const second = await submit(base, {
      producer: 'arboretum',
      claims: [{ ...fact, confidence: 0.4, prov: { source: 'arboretum', confidence: 0.4 } }],
    });

    const idOf = (receipt: SyncReceipt): string =>
      (receipt.accepted[0] ?? '').split(':claim:')[1] ?? '';
    expect(idOf(first.receipt)).toBe(idOf(second.receipt));
    // The envelope namespaces differ — the minting producer is on the envelope, not in the hash.
    expect(first.receipt.accepted[0]).toMatch(/^herbarium:claim:/);
    expect(second.receipt.accepted[0]).toMatch(/^arboretum:claim:/);
  });
});

describe('consumerFromManifest', () => {
  it('refuses to invent an address for a peer that publishes no knowledge sink', () => {
    const manifest: CapabilityManifest = {
      kcb_version: SPEC_VERSIONS.kcb,
      identity: 'someone:agent:media-only',
      endpoints: { a2a: 'http://127.0.0.1:1' },
      capabilities: [
        { name: 'render', inputs: [{ plane: 'media', media_types: ['video/mp4'] }] },
      ],
    };
    expect(() => consumerFromManifest(manifest)).toThrow(ConsumerError);
  });

  it('falls back to the provider\'s own endpoint when the capability names none', () => {
    const manifest: CapabilityManifest = {
      kcb_version: SPEC_VERSIONS.kcb,
      identity: 'someone:agent:authority',
      endpoints: { mcp: 'http://127.0.0.1:9/mcp' },
      capabilities: [{ name: 'ingest', inputs: [{ plane: 'knowledge' }] }],
    };
    expect(consumerFromManifest(manifest).endpoint).toBe('http://127.0.0.1:9/mcp');
  });
});
