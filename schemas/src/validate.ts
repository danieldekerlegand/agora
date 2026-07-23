#!/usr/bin/env node
/**
 * The TypeScript-ecosystem CLI over the ported koine interchange schemas — the runnable face of
 * `validator.ts`, absorbed from legacy's `validate.mjs` (ADR-0003).
 *
 * The library (`validate(name, instance): string[]`) is what code imports; this is what a shell
 * (and US-4's conformance CI smoke) invokes. Its exit codes are the contract, byte-identical to
 * the Python `artifact_validator.py` CLI so one CI loop can drive both ecosystems and a regression
 * in either turns the gate red:
 *
 *   0 = valid; 1 = invalid (errors printed); 2 = usage/load error.
 *
 * Usage:
 *   node schemas/src/validate.ts <schema-name> <artifact.json>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validate } from './validator.ts';
import { isJsonObject } from './json.ts';

const USAGE = 'usage: node schemas/src/validate.ts <schema-name> <artifact.json>';

/**
 * Run the validator over one artifact file and return the process exit code — never calling
 * `process.exit` itself, so a test can assert the code directly (as the Python `main` does).
 */
export function main(argv: string[]): number {
  if (argv.length !== 4) {
    console.error(USAGE);
    return 2;
  }
  const [, , name, artifactPath] = argv as [string, string, string, string];
  let instance: unknown;
  try {
    instance = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    console.error(`cannot load ${artifactPath}: ${(err as Error).message}`);
    return 2;
  }
  let errors: string[];
  try {
    errors = validate(name, instance);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (errors.length > 0) {
    for (const err of errors) console.log(`INVALID ${err}`);
    return 1;
  }
  // grounding-pack stamps its version into `kgp_version` (KGP §2), finetune-job into
  // `kft_version` (KFT §3); the other four keep `contractVersion`. Show whichever the
  // artifact carries — mirrors the Python CLI's version reader.
  const contract = isJsonObject(instance)
    ? (instance.contractVersion ?? instance.kgp_version ?? instance.kft_version ?? '?')
    : '?';
  console.log(`VALID ${artifactPath} against ${name} (contract ${String(contract)})`);
  return 0;
}

// When run directly (`node src/validate.ts`), exit with the CLI's code; when imported, do
// nothing but export `main`. Comparing import.meta.url to argv[1] is the ESM main-module idiom.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  process.exit(main(process.argv));
}
