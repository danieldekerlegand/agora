import { describe, expect, it } from 'vitest';

import {
  isCompatibleKcbVersion,
  ManifestError,
  parseManifest,
  SPEC_VERSIONS,
  type CapabilityManifest,
} from './index.ts';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kcb_version: SPEC_VERSIONS.kcb,
    identity: 'orchestrator:agent:composer',
    endpoints: { a2a: 'https://composer.example/.well-known/agent-card.json' },
    consumes: [{ plane: 'knowledge', shape: 'mood-descriptor' }],
    produces: [{ plane: 'media', media_types: ['audio/midi'], world_pattern: '*' }],
    capabilities: [
      {
        name: 'compose',
        inputs: [{ plane: 'knowledge', shape: 'mood-descriptor' }],
        outputs: [{ plane: 'media', media_types: ['audio/midi'] }],
        cost: { tier: 'paid', est_units: 1200 },
      },
    ],
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('accepts the KCB §2 example shape', () => {
    const parsed: CapabilityManifest = parseManifest(manifest());
    expect(parsed.identity).toBe('orchestrator:agent:composer');
    expect(parsed.capabilities?.[0]?.cost?.est_units).toBe(1200);
  });

  it('narrows in place, so fields this version does not model survive', () => {
    // The provider's manifest is authoritative (KCB §3) — the index is a cache of it,
    // not a reduction of it.
    const wire = manifest({ signing: { key_id: 'k1', alg: 'ed25519' }, futureField: [1, 2] });
    const parsed = parseManifest(wire);
    expect(parsed).toBe(wire);
    expect((parsed as unknown as Record<string, unknown>).futureField).toEqual([1, 2]);
  });

  it('requires a KINP identity — a provider is a fabric entity (§2)', () => {
    expect(() => parseManifest(manifest({ identity: 'composer' }))).toThrow(ManifestError);
    expect(() => parseManifest(manifest({ identity: 'composer' }))).toThrow(/manifest.identity/);
  });

  it('rejects a port on an unknown plane', () => {
    const bad = manifest({ produces: [{ plane: 'control' }] });
    expect(() => parseManifest(bad)).toThrow(/manifest.produces\[0\].plane/);
  });

  it('rejects a media port with no media types', () => {
    const bad = manifest({ produces: [{ plane: 'media' }] });
    expect(() => parseManifest(bad)).toThrow(/media_types/);
  });

  it('rejects a cost whose est_units is not a finite number', () => {
    const bad = manifest({
      capabilities: [{ name: 'compose', cost: { est_units: 'lots' } }],
    });
    expect(() => parseManifest(bad)).toThrow(/capabilities\[0\].cost.est_units/);
  });

  it('rejects junk outright', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest([])).toThrow(ManifestError);
    expect(() => parseManifest({})).toThrow(/kcb_version/);
  });
});

describe('isCompatibleKcbVersion', () => {
  it('reads its own version and later patches of it', () => {
    expect(isCompatibleKcbVersion(SPEC_VERSIONS.kcb)).toBe(true);
    expect(isCompatibleKcbVersion('0.2.7')).toBe(true);
  });

  it('refuses a different major, and pre-1.0 a different minor', () => {
    expect(isCompatibleKcbVersion('1.0.0')).toBe(false);
    expect(isCompatibleKcbVersion('0.1.0')).toBe(false);
  });

  it('refuses a manifest on an unreadable spec version', () => {
    expect(() => parseManifest(manifest({ kcb_version: '0.1.0' }))).toThrow(/not readable/);
  });
});
