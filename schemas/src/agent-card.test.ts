import { describe, expect, it } from 'vitest';

import {
  KCB_MANIFEST_EXTENSION_URI,
  type AgentCard,
  type AgentExtension,
} from './index.ts';

describe('AgentCard surface', () => {
  it('exports the ratified KCB manifest extension URI (capability-bus.md §2)', () => {
    expect(KCB_MANIFEST_EXTENSION_URI).toBe('https://koine.dev/kcb/manifest/0.3');
  });

  it('models a card whose KCB payload rides under capabilities.extensions[].params', () => {
    const extension: AgentExtension = {
      uri: KCB_MANIFEST_EXTENSION_URI,
      description: 'Koine capability-bus manifest',
      required: false,
      params: { kcb_version: '0.3.0' },
    };
    const card: AgentCard = {
      name: 'orchestrator:agent:composer',
      url: 'https://composer.example/a2a',
      capabilities: { extensions: [extension] },
    };
    expect(card.capabilities?.extensions?.[0]?.uri).toBe(KCB_MANIFEST_EXTENSION_URI);
    expect(card.capabilities?.extensions?.[0]?.params?.kcb_version).toBe('0.3.0');
  });
});
