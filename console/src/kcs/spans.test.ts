import { describe, expect, it } from 'vitest';

import { idsInSpan, readSpan, summariseSpan } from './spans.ts';

/** A provider's own record of an exchange it served for somebody else. */
const EXCHANGE = {
  kind: 'exchange',
  id: 'analyzer:span:sha256-3f77c1',
  provider: 'analyzer:agent:ingest',
  caller: 'composer:agent:composer',
  verb: 'invoke',
  capability: 'media.analyse',
  world: 'insimul:world:alderforest',
  tier: 'local-model',
  status: 'ok',
  budget_units: 120,
  actual_units: 18,
  started_at: '2026-07-22T11:04:31.018Z',
  duration_ms: 2140,
  entities: ['analyzer:asset:blake3-7c19ab'],
};

describe('reading emitted exchange telemetry', () => {
  it('reads every field a provider stated about an exchange it served', () => {
    const span = readSpan(EXCHANGE);
    expect(span).toMatchObject({
      verb: 'invoke',
      capability: 'media.analyse',
      caller: 'composer:agent:composer',
      provider: 'analyzer:agent:ingest',
      tier: 'local-model',
      status: 'ok',
      actual_units: 18,
      duration_ms: 2140,
      entities: ['analyzer:asset:blake3-7c19ab'],
    });
  });

  it('reads a span out of an envelope as readily as a flat frame', () => {
    const span = readSpan({ span: { verb: 'fetch', provider: 'analyzer:agent:ingest' } });
    expect(span?.verb).toBe('fetch');
    expect(span?.provider).toBe('analyzer:agent:ingest');
  });

  it('does not read a KGP delta as an invocation', () => {
    // The whole point of the narrow recognition rule: a monitor that inferred control-plane
    // events out of knowledge-plane ones would report exchanges nobody made.
    expect(
      readSpan({
        kgp_version: '0.4.0',
        kind: 'delta',
        assertions: [{ relation: 'commands', subject: 'insimul:world:w:ent:a' }],
      }),
    ).toBeUndefined();
  });

  it('refuses a telemetry frame that says neither what was done nor to what', () => {
    expect(readSpan({ kind: 'exchange', provider: 'analyzer:agent:ingest' })).toBeUndefined();
  });

  it('keeps a stated ceiling of none apart from an emitter that mentioned no ceiling', () => {
    expect(readSpan({ kind: 'exchange', verb: 'invoke', budget_units: null })?.budget_units).toBe(
      null,
    );
    expect(readSpan({ kind: 'exchange', verb: 'invoke' })?.budget_units).toBeUndefined();
  });

  it('names every KINP id the exchange touched, once each', () => {
    const span = readSpan(EXCHANGE);
    expect(span && idsInSpan(span)).toEqual([
      'analyzer:agent:ingest',
      'composer:agent:composer',
      'insimul:world:alderforest',
      'analyzer:asset:blake3-7c19ab',
    ]);
  });

  it('summarises an exchange as who asked whom for what, and what it cost', () => {
    const span = readSpan(EXCHANGE);
    expect(span && summariseSpan(span)).toBe(
      'invoke media.analyse (composer:agent:composer → analyzer:agent:ingest) · tier local-model · 18 units · ok',
    );
  });

  it('reads nothing out of a body that is not an object', () => {
    expect(readSpan(undefined)).toBeUndefined();
    expect(readSpan('exchange')).toBeUndefined();
    expect(readSpan([{ kind: 'exchange', verb: 'invoke' }])).toBeUndefined();
  });
});
