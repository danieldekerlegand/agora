import { describe, expect, it } from 'vitest';

import {
  EGRESS_CLASSES,
  isPlane,
  PLANE_SPECS,
  PLANES,
  RELATION_REGISTRY,
  SPEC_VERSIONS,
} from './index.ts';

describe('@agora/schemas', () => {
  it('pins the koine spec versions the commons implements', () => {
    expect(SPEC_VERSIONS.kcb).toBe('0.2.0');
    expect(SPEC_VERSIONS.kinp).toBe('0.2.0');
    expect(SPEC_VERSIONS.kgp).toBe('0.4.0');
    expect(SPEC_VERSIONS.kft).toBe('0.3.0');
  });

  it('re-exports the relation-registry pin', () => {
    expect(RELATION_REGISTRY.repo).toBe('koine');
  });

  it('re-exports the egress axis consumers enforce with', () => {
    expect([...EGRESS_CLASSES]).toEqual(['exportable', 'local-only']);
  });

  it('knows the three protocol planes', () => {
    expect([...PLANES]).toEqual(['knowledge', 'media', 'entity']);
  });

  it('names the koine contract that types a port on each plane (KCB §2.1)', () => {
    expect(PLANE_SPECS).toEqual({ knowledge: 'kgp', media: 'kmi', entity: 'kinp' });
    for (const plane of PLANES) expect(PLANE_SPECS[plane]).toBeTruthy();
  });

  it('rejects values that are not planes', () => {
    expect(isPlane('media')).toBe(true);
    expect(isPlane('control')).toBe(false);
    expect(isPlane(null)).toBe(false);
  });
});
