import { describe, expect, it } from 'vitest';

import type { EntityPort, KnowledgePort, MediaPort } from '@agora/schemas';

import { matchesPort, satisfies, servesWorld } from './index.ts';

const MOOD: KnowledgePort = { plane: 'knowledge', shape: 'mood-descriptor' };
const MIDI: MediaPort = { plane: 'media', media_types: ['audio/midi'] };
const WAV_ALDERFOREST: MediaPort = {
  plane: 'media',
  media_types: ['audio/wav'],
  world_pattern: 'alderforest',
};
const MOODS: EntityPort = { plane: 'entity', types: ['mood', 'scene'] };

describe('matchesPort', () => {
  it('matches everything when the query states nothing', () => {
    expect(matchesPort(MOOD, {})).toBe(true);
  });

  it('is a conjunction of the stated clauses', () => {
    expect(matchesPort(MOOD, { plane: 'knowledge', shape: 'mood-descriptor' })).toBe(true);
    expect(matchesPort(MOOD, { plane: 'knowledge', shape: 'prompt-text' })).toBe(false);
  });

  it('matches media types through a glob on either side', () => {
    expect(matchesPort(MIDI, { mediaType: 'audio/midi' })).toBe(true);
    expect(matchesPort(MIDI, { mediaType: 'audio/*' })).toBe(true);
    expect(matchesPort(MIDI, { mediaType: 'video/mp4' })).toBe(false);
  });

  it('answers a media-type query only from the media plane', () => {
    expect(matchesPort(MOOD, { mediaType: 'audio/*' })).toBe(false);
    expect(matchesPort(MOODS, { entityType: 'mood' })).toBe(true);
    expect(matchesPort(MOOD, { entityType: 'mood' })).toBe(false);
  });
});

describe('world scoping (delta J)', () => {
  it('matches a concrete world against the declared pattern', () => {
    expect(servesWorld(WAV_ALDERFOREST, 'alderforest')).toBe(true);
    expect(servesWorld(WAV_ALDERFOREST, 'consensus-reality')).toBe(false);
    expect(servesWorld({ ...WAV_ALDERFOREST, world_pattern: '*' }, 'anything')).toBe(true);
  });

  it('does not answer a world query from a port that declares no world', () => {
    // Delta J exists because world-scoped discovery is impossible without the
    // declaration — guessing "probably all worlds" hands back a provider that may not
    // hold the world's material at all.
    expect(servesWorld(MIDI, 'alderforest')).toBe(false);
  });

  it('reads a knowledge port’s explicit world list', () => {
    const port: KnowledgePort = {
      plane: 'knowledge',
      dialect: 'grounding-only',
      worlds: ['alderforest'],
    };
    expect(servesWorld(port, 'alderforest')).toBe(true);
    expect(servesWorld(port, 'elsewhere')).toBe(false);
  });
});

describe('satisfies — the path-search edge test', () => {
  it('never crosses planes', () => {
    expect(satisfies(MOOD, MIDI)).toBe(false);
  });

  it('holds when the consumer’s stated requirements are met', () => {
    expect(satisfies({ plane: 'knowledge', shape: 'mood-descriptor' }, MOOD)).toBe(true);
    expect(satisfies({ plane: 'knowledge', shape: 'prompt-text' }, MOOD)).toBe(false);
    // A consumer that states nothing accepts any port of the plane.
    expect(satisfies(MOOD, { plane: 'knowledge' })).toBe(true);
  });

  it('requires overlapping media types', () => {
    expect(satisfies(MIDI, { plane: 'media', media_types: ['audio/midi', 'audio/wav'] })).toBe(true);
    expect(satisfies(MIDI, { plane: 'media', media_types: ['video/mp4'] })).toBe(false);
  });

  it('constrains worlds only when both ends declare one', () => {
    const anyWorld: MediaPort = {
      plane: 'media',
      media_types: ['audio/wav'],
      world_pattern: '*',
    };
    const other: MediaPort = {
      plane: 'media',
      media_types: ['audio/wav'],
      world_pattern: 'consensus-reality',
    };
    expect(satisfies(WAV_ALDERFOREST, anyWorld)).toBe(true);
    expect(satisfies(WAV_ALDERFOREST, other)).toBe(false);
    // Producer says nothing about worlds: unscoped material, not wrong-world material.
    expect(satisfies({ plane: 'media', media_types: ['audio/wav'] }, other)).toBe(true);
  });

  it('requires overlapping entity types', () => {
    expect(satisfies(MOODS, { plane: 'entity', types: ['mood'] })).toBe(true);
    expect(satisfies(MOODS, { plane: 'entity', types: ['plugin'] })).toBe(false);
  });
});
