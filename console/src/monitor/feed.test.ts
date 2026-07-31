import { describe, expect, it } from 'vitest';

import { ObservationLog } from '../kcs/log.ts';
import { readFacts } from '../kcs/facts.ts';
import { readSpan } from '../kcs/spans.ts';
import { eventsFrom, feedFacets, filterFeed } from './feed.ts';

const CLAIM = {
  id: 'processor:claim:sha256-1d90ee',
  world: 'producer:world:sample',
  subject: 'processor:asset:blake3-7c19ab',
  relation: 'depicts',
  object: 'producer:world:sample:ent:item-alpha',
};

const ASSET = {
  id: 'processor:asset:blake3-7c19ab',
  media_type: 'video/mp4',
  source_world: 'producer:world:sample',
  attaches_to: ['producer:world:sample:ent:item-alpha'],
};

const SPAN = {
  kind: 'exchange',
  provider: 'processor:agent:ingest',
  caller: 'consumer:agent:composer',
  verb: 'invoke',
  capability: 'media.analyse',
  world: 'producer:world:sample',
};

/** A log with one frame per producer, as a sweep would have recorded them. */
function loggedSweep(): ObservationLog {
  const log = new ObservationLog(() => '2026-07-22T11:05:00.000Z');
  log.record({
    step: 'monitor',
    participant: 'producer:agent:publisher',
    direction: 'frame',
    plane: 'knowledge',
    entities: ['producer:agent:publisher'],
    detail: { standin: true },
    facts: readFacts({ assertions: [CLAIM] }),
  });
  log.record({
    step: 'monitor',
    participant: 'processor:agent:ingest',
    direction: 'frame',
    plane: 'media',
    entities: ['processor:agent:ingest'],
    detail: {},
    facts: readFacts({ assets: [ASSET] }),
  });
  log.record({
    step: 'monitor',
    participant: 'processor:agent:ingest',
    direction: 'frame',
    entities: ['processor:agent:ingest'],
    detail: {},
    span: readSpan(SPAN),
  });
  return log;
}

describe('the feed', () => {
  it('projects claims, assets and spans into one row each, in observed order', () => {
    const events = eventsFrom(loggedSweep().entries());
    expect(events.map((event) => event.kind)).toEqual(['claim', 'asset', 'span']);
    expect(events.map((event) => event.plane)).toEqual(['knowledge', 'media', 'control']);
  });

  it('links every row to the KINP ids it touched', () => {
    const [claim, asset, span] = eventsFrom(loggedSweep().entries());
    expect(claim?.ids).toContain('processor:claim:sha256-1d90ee');
    expect(asset?.ids).toContain('producer:world:sample:ent:item-alpha');
    expect(span?.ids).toContain('consumer:agent:composer');
  });

  it('files an emitted exchange on the control plane, not the knowledge plane', () => {
    // `control` is not a KCB data plane (§2.1). Calling a span `knowledge` because that is the
    // default would make the plane filter claim telemetry is a knowledge-plane event.
    const span = eventsFrom(loggedSweep().entries()).find((event) => event.kind === 'span');
    expect(span?.plane).toBe('control');
    expect(span?.summary).toContain('invoke media.analyse');
  });

  it('stamps the rows that came from a stand-in rather than a live producer', () => {
    const events = eventsFrom(loggedSweep().entries());
    expect(events.filter((event) => event.standin).map((event) => event.participant)).toEqual([
      'producer:agent:publisher',
    ]);
  });

  it('ignores the console’s own requests and responses — a feed is what peers published', () => {
    const log = loggedSweep();
    log.record({
      step: 'monitor',
      participant: 'processor:agent:ingest',
      direction: 'request',
      entities: ['processor:agent:ingest'],
      detail: { verb: 'subscribe' },
      facts: readFacts({ assertions: [CLAIM] }),
    });
    expect(eventsFrom(log.entries())).toHaveLength(3);
  });

  it('reads a claim’s world off its subject when the producer stated none', () => {
    const log = new ObservationLog(() => '2026-07-22T11:05:00.000Z');
    log.record({
      step: 'monitor',
      participant: 'producer:agent:publisher',
      direction: 'frame',
      entities: [],
      detail: {},
      facts: readFacts({
        assertions: [{ subject: 'producer:world:sample:ent:item-alpha', relation: 'flees' }],
      }),
    });
    expect(eventsFrom(log.entries())[0]?.world).toBe('producer:world:sample');
  });

  it('does not turn “depicts no world” into a world', () => {
    // KMI delta H: a stated `null` is a positive claim about a generated asset. A feed that
    // filed it under some world would put one world's claims in another world's stream.
    const log = new ObservationLog(() => '2026-07-22T11:05:00.000Z');
    log.record({
      step: 'monitor',
      participant: 'consumer:agent:composer',
      direction: 'frame',
      entities: [],
      detail: {},
      facts: readFacts({ assets: [{ id: 'consumer:asset:blake3-01', source_world: null }] }),
    });
    expect(eventsFrom(log.entries())[0]?.world).toBeUndefined();
  });
});

describe('filtering the feed', () => {
  const events = eventsFrom(loggedSweep().entries());

  it('narrows by participant, plane and world', () => {
    expect(filterFeed(events, { participant: 'processor:agent:ingest' })).toHaveLength(2);
    expect(filterFeed(events, { plane: 'control' })).toHaveLength(1);
    expect(filterFeed(events, { world: 'producer:world:sample' })).toHaveLength(3);
    expect(filterFeed(events, { world: 'producer:world:elsewhere' })).toHaveLength(0);
  });

  it('narrows by time, against the transaction time the log stamped', () => {
    expect(filterFeed(events, { since: '2026-07-22T11:05:00.000Z' })).toHaveLength(3);
    expect(filterFeed(events, { since: '2026-07-22T12:00:00.000Z' })).toHaveLength(0);
    expect(filterFeed(events, { until: '2026-07-22T10:00:00.000Z' })).toHaveLength(0);
  });

  it('combines clauses — every stated one must hold', () => {
    expect(
      filterFeed(events, { participant: 'processor:agent:ingest', plane: 'knowledge' }),
    ).toHaveLength(0);
  });

  it('offers only the values the feed actually holds', () => {
    expect(feedFacets(events)).toEqual({
      worlds: ['producer:world:sample'],
      planes: ['knowledge', 'media', 'control'],
      participants: ['producer:agent:publisher', 'processor:agent:ingest'],
    });
  });
});
