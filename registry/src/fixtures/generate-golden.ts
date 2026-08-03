/**
 * Capture the golden parity fixtures for the Rust path-index (US-1).
 *
 * The fixtures pin the behaviour of the CURRENT `findCapabilityPath` (registry/src/path.ts) so the
 * Rust port — and the TS fallback — can be proven byte-identical to the retired TypeScript, on
 * every fixture, forever. Each case records the exact registry input (the registrations the
 * registry holds, plus the `PathQuery`) and the exact `CapabilityPath` the search returned.
 *
 * Run it whenever the fixtures or the search contract change:
 *
 *     node registry/src/fixtures/generate-golden.ts
 *
 * The output `golden-paths.json` is the single source of truth read by BOTH the Rust golden test
 * (registry/path-index) and the TS shim test (registry/src/path-index.test.ts).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf } from '@agora/sdk';
import { parseManifest, type Capability, type CapabilityManifest } from '@agora/schemas';

import { findCapabilityPath, type CapabilityPath, type PathQuery } from '../path.ts';
import type { Registration } from '../registry.ts';
import {
  COMPOSER,
  DESCRIBER,
  NARRATOR,
  PREMIUM_RENDERER,
  RENDERER,
  UNPRICED_RENDERER,
} from './providers.ts';
import ROUTER from './provider-router.manifest.json' with { type: 'json' };

/** One pinned search: the registry's registrations, the query, and the answer it must keep giving. */
export interface GoldenCase {
  name: string;
  registrations: Registration[];
  query: PathQuery;
  expected: CapabilityPath | null;
}

/**
 * A synthetic multi-hop chain (topic → outline → score-sketch → midi → wav) so the fixtures cover a
 * path longer than the four-provider ecosystem set, with a priced and an unpriced final hop so
 * ranking is exercised across a deep chain — not just the leaf.
 */
const SYNTH: CapabilityManifest[] = [
  manifest('syn:agent:seed-describer', {
    name: 'outline',
    inputs: [{ plane: 'entity', types: ['topic'] }],
    outputs: [{ plane: 'knowledge', shape: 'outline' }],
    cost: { est_units: 10 },
  }),
  manifest('syn:agent:outliner', {
    name: 'sketch',
    inputs: [{ plane: 'knowledge', shape: 'outline' }],
    outputs: [{ plane: 'knowledge', shape: 'score-sketch' }],
    cost: { est_units: 10 },
  }),
  manifest('syn:agent:sketch-render', {
    name: 'render',
    inputs: [{ plane: 'knowledge', shape: 'score-sketch' }],
    outputs: [{ plane: 'media', media_types: ['audio/midi'] }],
    cost: { est_units: 10 },
  }),
  manifest('syn:agent:midi-master', {
    name: 'master',
    inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
    outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
    cost: { est_units: 100 },
  }),
  manifest('syn:agent:midi-cheap', {
    name: 'master',
    inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
    outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
    cost: { est_units: 0, unpriced: true },
  }),
];

function manifest(identity: string, capability: Capability): CapabilityManifest {
  return {
    kcb_version: ROUTER.kcb_version,
    identity,
    endpoints: { mcp: `https://${identity.split(':').pop()}.example/mcp` },
    capabilities: [capability],
  };
}

/**
 * The registrations the registry would hold for `manifests`, projected exactly the way
 * `CapabilityRegistry.register` does (parse, `addressOf`, 1-based registration order) — without
 * importing the registry class, so this stays runnable under Node's type-stripping.
 */
function register(manifests: unknown[]): Registration[] {
  return manifests.map((m, index) => {
    const parsed = parseManifest(m);
    return {
      identity: parsed.identity,
      manifest: parsed,
      address: addressOf(parsed),
      source: 'push',
      sequence: index + 1,
    };
  });
}

/** Register `manifests` in order and record the resulting case for `query`. */
function capture(name: string, manifests: unknown[], query: PathQuery): GoldenCase {
  const registrations = register(manifests);
  return { name, registrations, query, expected: findCapabilityPath(registrations, query) ?? null };
}

const ECOSYSTEM = [DESCRIBER, COMPOSER, RENDERER, PREMIUM_RENDERER, NARRATOR];

const CASES: GoldenCase[] = [
  capture('compose a score from a mood', ECOSYSTEM, {
    from: { entityType: 'mood' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('prefers the zero-cost render', ECOSYSTEM, {
    from: { mediaType: 'audio/midi' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('priced beats unpriced', [UNPRICED_RENDERER, PREMIUM_RENDERER], {
    from: { mediaType: 'audio/midi' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('world-scoped goal', ECOSYSTEM, {
    from: { shape: 'prompt-text' },
    to: { mediaType: 'audio/wav', world: 'alderforest' },
  }),
  capture('single-hop plan of addresses', [RENDERER], {
    from: { mediaType: 'audio/midi' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('no chain reaches the goal', ECOSYSTEM, {
    from: { entityType: 'mood' },
    to: { mediaType: 'video/mp4' },
  }),
  capture('bounded by maxHops (too short)', ECOSYSTEM, {
    from: { entityType: 'mood' },
    to: { mediaType: 'audio/wav' },
    maxHops: 2,
  }),
  capture('bounded by maxHops (just enough)', ECOSYSTEM, {
    from: { entityType: 'mood' },
    to: { mediaType: 'audio/wav' },
    maxHops: 3,
  }),
  capture('empty index', [], { from: {}, to: {} }),
  capture('provider-router serves prompt-text to audio at zero cost', [...ECOSYSTEM, ROUTER], {
    from: { shape: 'prompt-text' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('synthetic four-hop chain, priced final hop wins', SYNTH, {
    from: { entityType: 'topic' },
    to: { mediaType: 'audio/wav' },
  }),
  capture('synthetic chain bounded below its length', SYNTH, {
    from: { entityType: 'topic' },
    to: { mediaType: 'audio/wav' },
    maxHops: 3,
  }),
];

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'golden-paths.json');
const payload = {
  description:
    'Golden parity fixtures for the Rust path-index — captured from registry/src/path.ts ' +
    'findCapabilityPath. Regenerate with `node registry/src/fixtures/generate-golden.ts`.',
  cases: CASES,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`wrote ${CASES.length} golden cases to ${OUT}\n`);
