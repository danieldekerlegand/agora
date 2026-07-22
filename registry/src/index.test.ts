import { describe, expect, it } from 'vitest';

import { describeRegistry, REGISTRY_IDENTITY } from './index.ts';

describe('@agora/registry', () => {
  it('identifies itself in KINP terms', () => {
    expect(describeRegistry().identity).toBe(REGISTRY_IDENTITY);
  });

  it('never proxies traffic (ADR-0001 decision 3)', () => {
    expect(describeRegistry().proxiesTraffic).toBe(false);
  });
});
