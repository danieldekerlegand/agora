/**
 * The bridge's standalone entry point — boot the sync surface from the process environment.
 *
 * Unlike the registry, this one is **not** zero-config, and deliberately so: a knowledge bridge
 * with a default consumer would deliver somebody's claims to an address nobody chose. Two things
 * must be named, and both are addresses rather than code:
 *
 *   AGORA_KNOWLEDGE_CONSUMER            base URL a pack is POSTed to (required)
 *   AGORA_KNOWLEDGE_CONSUMER_IDENTITY   the consumer's KINP identity (required)
 *   AGORA_KNOWLEDGE_REGISTRY            base URL serving koine's registry/ (required)
 *   AGORA_KNOWLEDGE_DIALECT             the consumer's evaluable tier (default grounding-only)
 *   AGORA_KNOWLEDGE_LICENSES            comma-separated §7.1 allowlist (default the §7.1 three)
 *   AGORA_KNOWLEDGE_MIN_CONFIDENCE      the §7 confidence floor (default: none)
 *   AGORA_KNOWLEDGE_TRUSTED_SOURCES     comma-separated prov.source allowlist (default: any)
 *   AGORA_KNOWLEDGE_HOST / _PORT        bind address (default 127.0.0.1:8790)
 *
 * The relation registry is **loaded over the wire from koine**, never vendored (ADR-0001): the
 * process refuses to start without it, because a bridge that cannot check a relation against the
 * shared vocabulary has nothing to admit claims against.
 */
import { pathToFileURL } from 'node:url';

import { loadRelationRegistry } from '@agora/sdk';
import { DIALECT_TIERS, type DialectTier } from '@agora/schemas';

import type { AdmissionPolicy } from './admission.ts';
import { httpConsumer } from './consumer.ts';
import { isLicenseClass, type LicenseClass } from './license.ts';
import { createSyncServer, type SyncService } from './server.ts';
import { createKnowledgeSync } from './sync.ts';

/** The environment slice the entry point reads — a plain mapping, so a test can pass its own. */
export type KnowledgeEnv = Record<string, string | undefined>;

export const DEFAULT_KNOWLEDGE_HOST = '127.0.0.1';
export const DEFAULT_KNOWLEDGE_PORT = 8790;

/** The configuration a launch resolves to, before anything is fetched or bound. */
export interface KnowledgeLaunch {
  consumer: { identity: string; endpoint: string };
  registryUrl: string;
  policy: AdmissionPolicy;
  host: string;
  port: number;
}

/** Parse a launch out of an environment mapping. A missing requirement is a loud error. */
export function knowledgeLaunchFromEnv(env: KnowledgeEnv = {}): KnowledgeLaunch {
  const endpoint = required(env, 'AGORA_KNOWLEDGE_CONSUMER');
  const identity = required(env, 'AGORA_KNOWLEDGE_CONSUMER_IDENTITY');
  const registryUrl = required(env, 'AGORA_KNOWLEDGE_REGISTRY');
  const policy: AdmissionPolicy = {
    dialect: parseDialect(env.AGORA_KNOWLEDGE_DIALECT),
    ...(env.AGORA_KNOWLEDGE_LICENSES === undefined
      ? {}
      : { licenses: parseLicenses(env.AGORA_KNOWLEDGE_LICENSES) }),
    ...(env.AGORA_KNOWLEDGE_MIN_CONFIDENCE === undefined
      ? {}
      : { minConfidence: parseConfidence(env.AGORA_KNOWLEDGE_MIN_CONFIDENCE) }),
    ...(env.AGORA_KNOWLEDGE_TRUSTED_SOURCES === undefined
      ? {}
      : { trustedSources: parseList(env.AGORA_KNOWLEDGE_TRUSTED_SOURCES) }),
  };
  return {
    consumer: { identity, endpoint },
    registryUrl,
    policy,
    host: env.AGORA_KNOWLEDGE_HOST?.trim() || DEFAULT_KNOWLEDGE_HOST,
    port: parsePort(env.AGORA_KNOWLEDGE_PORT, DEFAULT_KNOWLEDGE_PORT, 'AGORA_KNOWLEDGE_PORT'),
  };
}

/** A bound, running bridge. */
export interface StartedKnowledgeSync {
  service: SyncService;
  host: string;
  port: number;
}

/** Load the registry, build the bridge from the environment, and start listening. */
export async function startKnowledgeSync(env: KnowledgeEnv = {}): Promise<StartedKnowledgeSync> {
  const launch = knowledgeLaunchFromEnv(env);
  const registry = await loadRelationRegistry(launch.registryUrl);
  const service = createSyncServer({
    sync: createKnowledgeSync({
      consumer: httpConsumer(launch.consumer),
      relations: (relation) => registry.relation(relation),
      policy: launch.policy,
    }),
  });
  const address = await service.listen(launch.port, launch.host);
  return { service, host: address.host, port: address.port };
}

function required(env: KnowledgeEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required — this bridge has no default consumer or registry`);
  }
  return value;
}

function parseDialect(raw: string | undefined): DialectTier {
  const value = raw?.trim();
  if (value === undefined || value === '') return 'grounding-only';
  if (!(DIALECT_TIERS as readonly string[]).includes(value)) {
    throw new Error(
      `AGORA_KNOWLEDGE_DIALECT must be one of ${DIALECT_TIERS.join(', ')} (KGP §5), got ${value}`,
    );
  }
  return value as DialectTier;
}

function parseLicenses(raw: string): readonly LicenseClass[] {
  return parseList(raw).map((entry) => {
    if (!isLicenseClass(entry)) {
      throw new Error(`AGORA_KNOWLEDGE_LICENSES: ${entry} is not a KGP §7.1 license class`);
    }
    return entry;
  });
}

function parseConfidence(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`AGORA_KNOWLEDGE_MIN_CONFIDENCE must be between 0 and 1, got ${raw}`);
  }
  return value;
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port (0-65535), got ${JSON.stringify(raw)}`);
  }
  return port;
}

// When run directly (`node src/main.ts`), boot the service; when imported, export only.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  startKnowledgeSync(process.env)
    .then(({ host, port }) => {
      console.log(`agora-knowledge-sync listening on http://${host}:${port}`);
    })
    .catch((err: unknown) => {
      console.error('agora-knowledge-sync failed to start:', err);
      process.exitCode = 1;
    });
}
