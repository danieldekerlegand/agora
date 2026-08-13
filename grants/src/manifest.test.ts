import { readFileSync } from 'node:fs';

import { createRegistry } from '@agora/registry';
import { parseManifest, parseManifestBody, SPEC_VERSIONS } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { GRANT_ISSUER_IDENTITY } from './issuer.ts';
import {
  AGENT_CARD_PATH,
  DERIVE_CAPABILITY,
  grantIssuerCard,
  grantIssuerManifest,
  ISSUE_CAPABILITY,
  KCB_MANIFEST_PATH,
} from './manifest.ts';

const BASE = 'http://127.0.0.1:8791';
const manifest = grantIssuerManifest(BASE);

describe('the issuer publishes a KCB manifest of its own', () => {
  it('is a valid manifest at the pinned spec version, identified as a fabric entity', () => {
    expect(parseManifestBody(manifest)).toEqual(manifest);
    expect(manifest.kcb_version).toBe(SPEC_VERSIONS.kcb);
    expect(manifest.identity).toBe(GRANT_ISSUER_IDENTITY);
  });

  it('advertises issuance and derivation as capabilities, each with its own address', () => {
    const names = (manifest.capabilities ?? []).map((capability) => capability.name);
    expect(names).toEqual([ISSUE_CAPABILITY, DERIVE_CAPABILITY]);
    expect(manifest.capabilities?.[0]?.endpoint).toBe(`${BASE}/grants`);
    expect(manifest.capabilities?.[1]?.endpoint).toBe(`${BASE}/grants/derive`);
    expect(manifest.endpoints.keys).toBe(`${BASE}/keys`);
  });

  it('prices issuance at zero — the step that says what the rest of a chain may spend', () => {
    for (const capability of manifest.capabilities ?? []) {
      expect(capability.cost).toMatchObject({ est_units: 0 });
      expect(capability.cost?.unpriced).toBeUndefined();
    }
  });

  it('requires no grant of its own, and says so by omission', () => {
    // §5 leaves identity providers to the host, and a derivation is authorized by the parent it
    // presents. Advertising `invoke:grant.issue` would demand a grant only this service can mint.
    expect(manifest.auth?.grants_required).toBeUndefined();
    expect(manifest.auth?.scheme).toBe('capability-grant');
  });

  it('rides on an AgentCard as its single KCB extension, the way a peer serves one', () => {
    const card = grantIssuerCard(BASE);
    expect(parseManifest(card)).toEqual(manifest);
    expect(card.url).toBe(BASE);
  });

  it('trims a trailing slash rather than minting a double-slashed address', () => {
    expect(grantIssuerManifest(`${BASE}/`).endpoints.grants).toBe(`${BASE}/grants`);
  });

  it('names no participant — the issuer is a capability, never a caller', () => {
    // Whatever principal the host names is data, and never a literal in this tree.
    const source = readFileSync(new URL('./manifest.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/grantee:\s*'/);
    expect(JSON.stringify(manifest)).not.toContain('example:');
  });
});

describe('a registry can discover it, and hands back an address', () => {
  it('indexes the manifest and answers find() with where to dial', () => {
    const registry = createRegistry();
    registry.register(manifest, { source: 'pull' });

    const [match, ...rest] = registry.find({ capability: ISSUE_CAPABILITY });
    expect(rest).toEqual([]);
    expect(match?.identity).toBe(GRANT_ISSUER_IDENTITY);
    expect(match?.capabilities[0]?.endpoint).toBe(`${BASE}/grants`);
    expect(match?.estUnits).toBe(0);

    // ADR-0001 decision 3, restated where it matters most: discovery hands back an address and
    // the caller mints *directly*. A credential that travelled through the registry would make
    // the registry a party to every authorization on the fabric.
    expect(registry.proxiesTraffic).toBe(false);
    expect(registry.address(GRANT_ISSUER_IDENTITY)?.endpoints).toMatchObject({
      a2a: `${BASE}${AGENT_CARD_PATH}`,
    });
  });

  it('is discoverable by the grant it produces, not only by name', () => {
    const registry = createRegistry();
    registry.register(manifest, { source: 'pull' });
    const byPort = registry.find({ produces: { plane: 'entity', entityType: 'capability-grant' } });
    expect(byPort.map((match) => match.identity)).toEqual([GRANT_ISSUER_IDENTITY]);
    expect(registry.find({ capability: DERIVE_CAPABILITY })).toHaveLength(1);
  });

  it('publishes the manifest at the path a crawl pulls', () => {
    expect(KCB_MANIFEST_PATH).toBe('/.well-known/kcb-manifest.json');
    expect(manifest.endpoints.manifest).toBe(`${BASE}${KCB_MANIFEST_PATH}`);
  });
});
