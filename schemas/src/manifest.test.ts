import { describe, expect, it } from 'vitest';

import {
  embedManifest,
  isCapabilityManifest,
  isCompatibleKcbVersion,
  KCB_MANIFEST_EXTENSION_URI,
  ManifestError,
  parseManifest,
  parseManifestBody,
  SPEC_VERSIONS,
  toAgentCardExtension,
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

describe('emitting the KCB extension', () => {
  it('wraps a manifest as the single KCB extension, uri + required per §2', () => {
    const body = parseManifestBody(manifestBody());
    const extension = toAgentCardExtension(body);
    expect(extension.uri).toBe(KCB_MANIFEST_EXTENSION_URI);
    expect(extension.required).toBe(false);
    expect(extension.params).toBe(body);
  });

  it('advertises no endpoint the source manifest does not carry', () => {
    const body = parseManifestBody(manifestBody());
    const extension = toAgentCardExtension(body);
    // The params are the manifest body verbatim — the emitter invents no endpoints of its own.
    expect(extension.params?.endpoints).toBe(body.endpoints);
    expect(Object.keys(extension.params?.endpoints as object)).toEqual(['a2a']);
  });

  it('emit ∘ parse is the identity on the KCB §2 example (round-trips through a card)', () => {
    const body = parseManifestBody(manifestBody());
    const card = embedManifest({ name: body.identity, url: 'https://composer.example/a2a' }, body);
    const parsed = parseManifest(card);
    expect(parsed).toEqual(body);
    expect(parsed).toBe(body); // narrow-in-place: the body is not rebuilt on the way out or back
  });

  it('embedManifest replaces an existing KCB extension and preserves the rest of the card', () => {
    const first = parseManifestBody(manifestBody());
    const second = parseManifestBody(manifestBody({ identity: 'orchestrator:agent:remix' }));
    const card = embedManifest(
      {
        name: 'orchestrator:agent:composer',
        capabilities: { extensions: [{ uri: 'https://example.com/other/1' }] },
        experimentalCardField: 'keep-me',
      },
      first,
    );
    const replaced = embedManifest(card, second);
    // Exactly one KCB extension survives (parseManifest would throw on two), now the second body.
    expect(parseManifest(replaced).identity).toBe('orchestrator:agent:remix');
    const kcb = replaced.capabilities?.extensions?.filter(
      (e) => e.uri === KCB_MANIFEST_EXTENSION_URI,
    );
    expect(kcb).toHaveLength(1);
    // Someone else's extension and unmodeled card fields are left alone.
    expect(replaced.capabilities?.extensions?.some((e) => e.uri === 'https://example.com/other/1')).toBe(
      true,
    );
    expect((replaced as Record<string, unknown>).experimentalCardField).toBe('keep-me');
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
