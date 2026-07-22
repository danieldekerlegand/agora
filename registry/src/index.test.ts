import { describe, expect, it } from 'vitest';

import { createRegistry, describeRegistry, REGISTRY_IDENTITY } from './index.ts';

describe('@agora/registry', () => {
  it('identifies itself in KINP terms', () => {
    expect(describeRegistry().identity).toBe(REGISTRY_IDENTITY);
  });

  it('never proxies traffic (ADR-0001 decision 3)', () => {
    expect(describeRegistry().proxiesTraffic).toBe(false);
    expect(createRegistry().proxiesTraffic).toBe(false);
  });

  it('offers discovery verbs only — invoking is the caller’s job, not the index’s', () => {
    // If `invoke`, `proxy` or `forward` ever appears on this surface, the registry has
    // become the traffic hub ADR-0001 decisions 3-4 reject. Widen the list deliberately.
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(createRegistry()) as object,
    ).filter((name) => name !== 'constructor');
    expect(surface.sort()).toEqual([...describeRegistry().verbs].sort());
  });
});
