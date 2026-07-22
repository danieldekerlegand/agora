import { describe, expect, it } from 'vitest';

import { isPlane, PLANES, SPEC_VERSIONS } from './index.ts';

describe('@agora/schemas', () => {
  it('pins the koine spec versions the commons implements', () => {
    expect(SPEC_VERSIONS.kcb).toBe('0.2.0');
    expect(SPEC_VERSIONS.kinp).toBe('0.2.0');
  });

  it('knows the three protocol planes', () => {
    expect([...PLANES]).toEqual(['knowledge', 'media', 'entity']);
  });

  it('rejects values that are not planes', () => {
    expect(isPlane('media')).toBe(true);
    expect(isPlane('control')).toBe(false);
    expect(isPlane(null)).toBe(false);
  });
});
