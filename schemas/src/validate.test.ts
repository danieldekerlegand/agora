/**
 * The TS CLI's exit-code contract (`validate.ts`) — the half of US-3's "both sides" parity that
 * lives in the TypeScript ecosystem. 0 = valid, 1 = invalid, 2 = usage/load error, byte-identical
 * to the Python `artifact_validator.py` CLI so US-4's conformance smoke can loop both.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './validate.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'conformance', 'fixtures');
const GROUNDING_PACK = join(FIXTURES_DIR, 'grounding-pack.json');

/** argv the way `process.argv` hands it in: [node, script, ...args]. */
function argv(...args: string[]): string[] {
  return ['node', 'validate.ts', ...args];
}

describe('validate CLI exit codes', () => {
  // Silence the CLI's own INVALID/VALID/usage output; the codes are what we assert.
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 for a valid artifact', () => {
    expect(main(argv('grounding-pack', GROUNDING_PACK))).toBe(0);
  });

  it('exits 1 for an invalid artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agora-validate-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, JSON.stringify({ contractVersion: '0.1.0' }));
    expect(main(argv('analyzer-canonical-export', path))).toBe(1);
  });

  it('exits 2 for an unknown schema name', () => {
    expect(main(argv('not-a-schema', GROUNDING_PACK))).toBe(2);
  });

  it('exits 2 for a missing artifact file', () => {
    expect(main(argv('grounding-pack', join(tmpdir(), 'does-not-exist-agora.json')))).toBe(2);
  });

  it('exits 2 for the wrong argument count', () => {
    expect(main(argv())).toBe(2);
  });
});
