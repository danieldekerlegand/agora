/**
 * The SDK as an OUT-OF-TREE CONSUMER sees it.
 *
 * Everything here imports the published entry point `@agora/sdk` by name — never `./kcb.ts`,
 * never a deep path — so this file fails exactly when a newcomer following the quickstart would.
 * `kcb.test.ts` and `relation-registry.test.ts` cover the modules from the inside; this one
 * covers the promise the package makes to someone who ran `npm install`.
 */
import { readFileSync } from 'node:fs';

import * as sdk from '@agora/sdk';
import { describe, expect, it } from 'vitest';

const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string; exports: Record<string, unknown>; private?: boolean };

/** Every name `SDK_API` claims, flattened. Types are erased at runtime and are not in here. */
const ENUMERATED = Object.values(sdk.SDK_API).flat();

/** The three self-describing exports, which document the surface rather than being part of it. */
const SELF_DESCRIBING = ['SDK_API', 'SDK_VERSION', 'describeSdk'];

describe('@agora/sdk — the published surface', () => {
  it('is a versioned, publishable package, not a workspace-only source export', () => {
    expect(PACKAGE.name).toBe('@agora/sdk');
    expect(PACKAGE.private).toBeUndefined();
    expect(PACKAGE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdk.SDK_VERSION).toBe(PACKAGE.version);
  });

  it('enumerates its own API, with nothing exported that the index omits', () => {
    const exported = Object.keys(sdk).sort();
    expect(exported).toEqual([...ENUMERATED, ...SELF_DESCRIBING].sort());
  });

  it('speaks the koine spec versions the schemas package pins', () => {
    expect(sdk.describeSdk().specs).toEqual(sdk.SPEC_VERSIONS);
    expect(sdk.KCB_CLIENT_VERSION).toBe(sdk.SPEC_VERSIONS.kcb);
  });

  it('never grows a relay: the surface names no verb that would carry a payload', () => {
    // ADR-0001 decisions 2-4. Asserted on the module's own exports, because "we return
    // addresses" is what every traffic hub's README said before it grew an invoke().
    const relaying = Object.keys(sdk).filter((name) =>
      /relay|proxy|invoke|forward|dispatch|^call|^send|^dial|^request/i.test(name),
    );
    expect(relaying).toEqual([]);
    expect(sdk.describeSdk().relaysPayloads).toBe(false);
  });
});

describe('@agora/sdk — discovering a capability yields an address to dial', () => {
  const a2a = 'https://provider.example/a2a';
  const manifest: sdk.CapabilityManifest = {
    kcb_version: sdk.SPEC_VERSIONS.kcb,
    identity: 'example:agent:sample-provider',
    endpoints: { a2a },
    capabilities: [{ name: 'summarize.text', endpoint: `${a2a}/summarize` }],
  };

  it('round-trips a manifest through an AgentCard and back out as an address', () => {
    // What a consumer really does: fetch a peer's card, read the KCB extension off it, and
    // project that manifest onto the endpoint it will dial itself.
    const card = sdk.embedManifest({ name: manifest.identity, url: a2a }, manifest);
    const parsed = sdk.parseManifest(card);
    const address = sdk.addressOf(parsed);

    expect(address.identity).toBe('example:agent:sample-provider');
    expect(sdk.isDialable(address)).toBe(true);
    expect(sdk.endpointFor(address, parsed.capabilities?.[0])).toBe(
      'https://provider.example/a2a/summarize',
    );
    expect(sdk.transportOf(address, parsed.capabilities?.[0])).toBe('a2a');
  });

  it('returns no address rather than inventing one when the provider published none', () => {
    const address = sdk.addressOf({ ...manifest, endpoints: {} });
    expect(sdk.isDialable(address)).toBe(false);
    expect(sdk.endpointFor(address)).toBeUndefined();
  });
});
