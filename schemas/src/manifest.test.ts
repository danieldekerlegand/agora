import { describe, expect, it } from 'vitest';

import {
  isCapabilityManifest,
  isCompatibleKcbVersion,
  KCB_MANIFEST_EXTENSION_URI,
  ManifestError,
  parseManifest,
  parseManifestBody,
  SPEC_VERSIONS,
  type AgentCard,
  type CapabilityManifest,
} from './index.ts';

/** The KCB manifest body — the payload that rides under `capabilities.extensions[].params` (§2). */
function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/**
 * The A2A AgentCard a provider serves at `/.well-known/agent-card.json` (§2): the KCB
 * {@link manifestBody} rides as the single {@link KCB_MANIFEST_EXTENSION_URI} extension.
 */
function manifest(
  bodyOverrides: Record<string, unknown> = {},
  cardOverrides: Record<string, unknown> = {},
): AgentCard {
  return {
    name: 'orchestrator:agent:composer',
    url: 'https://composer.example/a2a',
    capabilities: {
      extensions: [
        {
          uri: KCB_MANIFEST_EXTENSION_URI,
          description: 'Koine capability-bus manifest',
          required: false,
          params: manifestBody(bodyOverrides),
        },
      ],
    },
    ...cardOverrides,
  };
}

describe('parseManifest', () => {
  it('reads the KCB §2 example out of the card extension', () => {
    const parsed: CapabilityManifest = parseManifest(manifest());
    expect(parsed.identity).toBe('orchestrator:agent:composer');
    expect(parsed.capabilities?.[0]?.cost?.est_units).toBe(1200);
  });

  it('narrows in place — unknown fields on the params and on the card both survive (§3)', () => {
    // The provider's manifest is authoritative (KCB §3): the index is a cache of it, not a
    // reduction of it — neither the extension params nor the surrounding card get rebuilt.
    const card = manifest(
      { signing: { key_id: 'k1', alg: 'ed25519' }, futureField: [1, 2] },
      { experimentalCardField: 'keep-me' },
    );
    const parsed = parseManifest(card);
    expect(parsed).toBe(card.capabilities?.extensions?.[0]?.params);
    expect((parsed as unknown as Record<string, unknown>).futureField).toEqual([1, 2]);
    expect((card as Record<string, unknown>).experimentalCardField).toBe('keep-me');
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
    expect(() => parseManifest({})).toThrow(/KCB manifest extension/);
  });
});

describe('the KCB extension on the card', () => {
  it('throws, naming the path, when the card carries no KCB manifest extension', () => {
    const noExtensions = manifest({}, { capabilities: {} });
    expect(() => parseManifest(noExtensions)).toThrow(ManifestError);
    expect(() => parseManifest(noExtensions)).toThrow(/capabilities.extensions/);
    // A card whose only extension is somebody else's advertises no KCB ports (§3).
    const otherOnly = manifest(
      {},
      { capabilities: { extensions: [{ uri: 'https://example.com/other/1' }] } },
    );
    expect(() => parseManifest(otherOnly)).toThrow(/found none/);
  });

  it('throws when the card carries more than one KCB manifest extension', () => {
    const twice = manifest(
      {},
      {
        capabilities: {
          extensions: [
            { uri: KCB_MANIFEST_EXTENSION_URI, params: manifestBody() },
            { uri: KCB_MANIFEST_EXTENSION_URI, params: manifestBody() },
          ],
        },
      },
    );
    expect(() => parseManifest(twice)).toThrow(ManifestError);
    expect(() => parseManifest(twice)).toThrow(/expected exactly one/);
  });

  it('names the offending path inside the params when they fail validation', () => {
    const bad = manifest({ endpoints: { a2a: 42 } });
    expect(() => parseManifest(bad)).toThrow(/manifest.endpoints.a2a/);
  });
});

describe('parseManifestBody vs parseManifest', () => {
  it('validates a bare params body, while parseManifest wants the whole card', () => {
    const body = manifestBody();
    expect(parseManifestBody(body).identity).toBe('orchestrator:agent:composer');
    // The bare body is not itself an AgentCard — its `capabilities` is the invocable-unit
    // array, not `{ extensions }` — so parseManifest rejects it.
    expect(() => parseManifest(body)).toThrow(/KCB manifest extension/);
    // And the card is not a bare body: it has no top-level kcb_version.
    expect(() => parseManifestBody(manifest())).toThrow(/kcb_version/);
  });

  it('isCapabilityManifest guards a full card, not a bare body', () => {
    expect(isCapabilityManifest(manifest())).toBe(true);
    expect(isCapabilityManifest(manifestBody())).toBe(false);
    expect(isCapabilityManifest({})).toBe(false);
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
