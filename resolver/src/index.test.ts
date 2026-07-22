import { describe, expect, it } from 'vitest';

import { describeResolver, RESOLVER_IDENTITY } from './index.ts';

describe('@agora/resolver', () => {
  it('identifies itself in KINP terms and pins the KINP version', () => {
    expect(describeResolver()).toEqual({
      identity: RESOLVER_IDENTITY,
      kinpVersion: '0.2.0',
    });
  });
});
