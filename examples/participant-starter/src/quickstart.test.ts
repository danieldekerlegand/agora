/**
 * `docs/quickstart.md` is a promise that every command in it is real. This test is what keeps
 * that promise true after the code moves.
 *
 * It holds the doc against the shipped things it claims: the SDK's actual exports, the starter's
 * actual constants and output, the real package versions in the install step, the Makefile targets
 * it tells a newcomer to run, and the files its links point at. The doc's happy path is read out
 * of the doc itself and re-derived from the code — so a renamed export, a changed capability name,
 * a version bump or a moved file turns this red instead of leaving a newcomer stranded at step 1.
 *
 * It is a doc test, so it reads by path (repo root, three levels up from here) the way the
 * cross-language pins do. Moving `docs/quickstart.md` means moving it here too — that is the
 * point.
 */
import { readFileSync } from 'node:fs';

import { parseManifestBody } from '@agora/schemas';
import * as sdk from '@agora/sdk';
import {
  addressOf,
  BUDGET_UNITS_HEADER,
  endpointFor,
  isDialable,
  KCB_MANIFEST_EXTENSION_URI,
  openAiConfigFor,
  SPEC_VERSIONS,
  transportOf,
} from '@agora/sdk';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY,
  CARD_PATH,
  DEFAULT_PORT,
  IDENTITY,
  MANIFEST_PATH,
  participantManifest,
  summarize,
} from './participant.ts';

/** The repo root — `examples/participant-starter/src/` is three levels down from it. */
const ROOT = new URL('../../../', import.meta.url);

function readFromRoot(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), 'utf8');
}

const QUICKSTART_PATH = 'docs/quickstart.md';
const quickstart = readFromRoot(QUICKSTART_PATH);

/** The base URL the doc walks a newcomer through, built from the starter's own default port. */
const DOC_BASE = `http://localhost:${DEFAULT_PORT}`;

describe('docs/quickstart.md', () => {
  it('imports only names the SDK actually exports', () => {
    const imports = [...quickstart.matchAll(/import \{([^}]+)\} from '@agora\/sdk'/g)].flatMap(
      ([, names]) => (names ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    );

    expect(imports.length).toBeGreaterThan(0);
    for (const name of imports) expect(Object.keys(sdk)).toContain(name);
  });

  it('describes the peer the starter actually serves', () => {
    const manifest = participantManifest(DOC_BASE);

    expect(quickstart).toContain(IDENTITY);
    expect(quickstart).toContain(CAPABILITY);
    expect(quickstart).toContain(`${DOC_BASE}${CARD_PATH}`);
    expect(quickstart).toContain(MANIFEST_PATH);
    // The card excerpt is a real card: the KCB extension URI and the pinned spec version.
    expect(quickstart).toContain(KCB_MANIFEST_EXTENSION_URI);
    expect(quickstart).toContain(`"kcb_version": "${SPEC_VERSIONS.kcb}"`);
    expect(quickstart).toContain(`"a2a": "${manifest.endpoints.a2a}"`);
    expect(quickstart).toContain(`"manifest": "${manifest.endpoints.manifest}"`);
  });

  it('shows the answer the starter really gives to the prompt it really sends', () => {
    const [, prompt] = /"parts":\[\{"kind":"text","text":"([^"]+)"\}\]/.exec(quickstart) ?? [];
    expect(prompt, 'the curl body in step 2 carries a text part').toBeDefined();

    const answer = summarize(prompt as string);
    expect(quickstart).toContain(`"text":"${answer}"`); // the curl response
    expect(quickstart).toContain(`# ${answer}`); // the node call-a-peer.mjs output
  });

  it('prints what the SDK really projects out of that card', () => {
    const manifest = participantManifest(DOC_BASE);
    const address = addressOf(manifest);
    const capability = manifest.capabilities?.[0];

    // Step 3's console.log, character for character — three values, straight off the SDK.
    const projected = [
      isDialable(address),
      transportOf(address, capability),
      endpointFor(address, capability),
    ].join(' ');
    expect(quickstart).toContain(`# ${projected}`);
  });

  it('prints the gateway config the SDK really projects out of the router manifest', () => {
    // The doc quotes a config block; it is read back out of the real router's captured manifest,
    // so a router that changed its endpoints or its ceiling header turns this red.
    const router = parseManifestBody(
      JSON.parse(readFromRoot('registry/src/fixtures/provider-router.manifest.json')),
    );
    const config = openAiConfigFor(router, { capability: 'generate.text', budgetUnits: 0 });

    expect(quickstart).toContain(`baseUrl: '${config?.baseUrl ?? ''}'`);
    expect(quickstart).toContain(`'${BUDGET_UNITS_HEADER}': '0'`);
    expect(quickstart).toContain(`model: '${config?.model ?? ''}'`);
    expect(quickstart).toContain(`budgetUnitsKey: '${config?.budgetUnitsKey ?? ''}'`);
    expect(config?.headers).toEqual({ [BUDGET_UNITS_HEADER]: '0' });
  });

  it('installs the versions this repo would actually publish', () => {
    for (const pkg of ['schemas', 'clients/sdk']) {
      const { name, version } = JSON.parse(readFromRoot(`${pkg}/package.json`)) as {
        name: string;
        version: string;
      };
      // What `npm pack` names the tarball: @agora/sdk@0.1.0 → agora-sdk-0.1.0.tgz.
      expect(quickstart).toContain(`${name.slice(1).replace('/', '-')}-${version}.tgz`);
    }
    expect(sdk.SDK_VERSION).toBe(
      (JSON.parse(readFromRoot('clients/sdk/package.json')) as { version: string }).version,
    );
  });

  it('names make targets that exist', () => {
    const makefile = readFromRoot('Makefile');
    const targets = [...quickstart.matchAll(/^\s*(?:# )?make ([a-z-]+)/gm)].map(([, t]) => t ?? '');

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(makefile, `make ${target}`).toContain(`\n${target}:`);
  });

  it('points only at files that exist', () => {
    // Every `node <script.ts>` a shell block runs, and every non-external markdown link.
    const paths = [
      ...[...quickstart.matchAll(/^node (\S+\.ts)/gm)].map(([, p]) => p ?? ''),
      ...[...quickstart.matchAll(/\]\(([^)]+)\)/g)]
        .map(([, p]) => p ?? '')
        .filter((p) => !p.startsWith('http') && !p.startsWith('#'))
        .map((p) => `docs/${p.split('#')[0] ?? ''}`),
    ];

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(() => readFromRoot(path), path).not.toThrow();
  });

  it('states the addresses-not-proxies model rather than implying a relay', () => {
    expect(quickstart).toMatch(/addresses, not a relay/i);
    expect(quickstart).toContain('relaysPayloads');
    expect(quickstart).toContain('ADR-0001-control-plane-topology.md');
    // The three ways an SDK would advertise relaying. None of them exist; none may appear here.
    expect(quickstart).not.toMatch(/\bsdk\.(invoke|call|send)\(/);
  });

  it('is linked from the README, which is where a newcomer starts', () => {
    expect(readFromRoot('README.md')).toContain(`(${QUICKSTART_PATH})`);
  });
});
