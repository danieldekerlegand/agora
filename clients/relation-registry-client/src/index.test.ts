import {
  assertPackEgress,
  bridgedProjectsOf,
  filterPackForEgress,
  RegistryError,
  RELATION_REGISTRY,
} from '@agora/schemas';
import { KOINE_PREDICATE_MAPPING, KOINE_VOCABULARY } from '@agora/schemas/fixtures';
import { describe, expect, it } from 'vitest';

import { loadRelationRegistry, RegistryFetchError, type RegistryFetch } from './index.ts';

const BASE = 'https://koine.example';

/**
 * koine served over HTTP, from the real registry snapshot. `overrides` replaces one file's
 * body, which is how a test poses a registry the loader must refuse.
 */
function serving(overrides: Record<string, string> = {}): [RegistryFetch, string[]] {
  const files = new Map<string, string>([
    [RELATION_REGISTRY.mappings, JSON.stringify(KOINE_PREDICATE_MAPPING)],
    ...KOINE_VOCABULARY.map((file) => [file.path, file.text] as [string, string]),
    ...Object.entries(overrides),
  ]);
  const urls: string[] = [];
  const fetch: RegistryFetch = (url) => {
    urls.push(url);
    const body = files.get(url.slice(`${BASE}/`.length));
    return Promise.resolve(
      body === undefined
        ? { ok: false, status: 404, text: () => Promise.resolve('') }
        : { ok: true, status: 200, text: () => Promise.resolve(body) },
    );
  };
  return [fetch, urls];
}

/** The registry document with one edit, serialized as it would arrive off the wire. */
function doctored(edit: (draft: Record<string, unknown>) => void): string {
  const draft = JSON.parse(JSON.stringify(KOINE_PREDICATE_MAPPING)) as Record<string, unknown>;
  edit(draft);
  return JSON.stringify(draft);
}

describe('loadRelationRegistry', () => {
  it('fetches the mappings and the vocabulary the document names — and nothing else', async () => {
    const [fetch, urls] = serving();
    const registry = await loadRelationRegistry(BASE, { fetch });

    expect(urls).toEqual([
      `${BASE}/registry/predicate-mapping.json`,
      `${BASE}/registry/relations.tsv`,
      `${BASE}/registry/relations/cinematography.tsv`,
      `${BASE}/registry/relations/media.tsv`,
      `${BASE}/registry/relations/social.tsv`,
    ]);
    expect(registry.document.registryVersion).toBe(RELATION_REGISTRY.version);
    expect(registry.relation('cine:shows')?.arity).toBe(2);
    expect(registry.signature('soc:parent_of')).toBe('soc:parent_of · 2 · parent|child · false');
    // Not a guess: an unknown relation is a bug in the caller or a stale registry.
    expect(registry.relation('soc:befriends')).toBeUndefined();
    expect(registry.signature('soc:befriends')).toBeUndefined();
  });

  it('indexes every project the served registry declares, and no other', async () => {
    const [fetch] = serving();
    const registry = await loadRelationRegistry(BASE, { fetch });
    const bridged = bridgedProjectsOf(registry.document);
    expect(bridged.length).toBeGreaterThan(0);
    for (const project of bridged) {
      expect(registry.entries(project).length).toBeGreaterThan(0);
    }
    // The canonical side hosts the vocabulary rather than bridging into it, so it has no
    // entries — and neither has any name the loaded registry never mentioned.
    expect(registry.entries(registry.document.canonicalProject ?? 'nobody')).toEqual([]);
    expect(registry.entries('a-project-this-registry-never-heard-of')).toEqual([]);
  });

  it('reports a failed fetch as a RegistryFetchError naming the url', async () => {
    const [fetch] = serving();
    await expect(loadRelationRegistry(`${BASE}/wrong`, { fetch })).rejects.toThrow(
      RegistryFetchError,
    );
  });

  it('refuses a registry whose version this build does not speak', async () => {
    const [fetch] = serving({
      [RELATION_REGISTRY.mappings]: doctored((draft) => {
        draft.registryVersion = '0.2.0';
      }),
    });
    await expect(loadRelationRegistry(BASE, { fetch })).rejects.toThrow(RegistryError);
  });

  it('refuses a registry that moved its vocabulary out from under the pinned layout', async () => {
    const [fetch] = serving({
      [RELATION_REGISTRY.mappings]: doctored((draft) => {
        (draft.relationRegistry as { core: string }).core = 'vocabulary/relations.tsv';
      }),
    });
    await expect(loadRelationRegistry(BASE, { fetch })).rejects.toThrow(/core vocabulary/);
  });

  it('catches a mapping left naming a relation no served vocabulary declares', async () => {
    // Dropping a domain file is the realistic version of a fork: the mappings still name
    // `soc:parent_of`, and without social.tsv nothing defines what it means. Caught at load,
    // rather than at claim time by whoever hashes the claim.
    const [fetch] = serving({
      [RELATION_REGISTRY.mappings]: doctored((draft) => {
        const index = draft.relationRegistry as { domains: string[] };
        index.domains = index.domains.filter((path) => !path.endsWith('social.tsv'));
      }),
    });
    await expect(loadRelationRegistry(BASE, { fetch })).rejects.toThrow(/add it to the TSV/);
  });
});

describe('the egress lookup the loader hands to the §7.2 filter', () => {
  it('classifies a bridged project’s own predicates', async () => {
    const [fetch] = serving();
    const registry = await loadRelationRegistry(BASE, { fetch });
    const analyzer = registry.egressFor('analyzer');

    // A user's own files: `shows(asset, X)` is about their footage and never leaves.
    expect(analyzer('shows')).toBe('local-only');
    expect(analyzer('scene')).toBe('local-only');
    expect(analyzer('derived_from')).toBe('exportable');
    // Unmentioned: the registry says nothing, and §7.2's default is the caller's to apply.
    expect(analyzer('invented_predicate')).toBeUndefined();
    // A generated world is `synthetic` TRUST, which is not `local-only` EGRESS — but a real
    // person's data inside it is.
    const insimul = registry.egressFor('insimul');
    expect(insimul('married_to')).toBe('exportable');
    expect(insimul('player_cefr_level')).toBe('local-only');
  });

  it('reports the dialect a consumer would need, on the other axis', async () => {
    const [fetch] = serving();
    const registry = await loadRelationRegistry(BASE, { fetch });
    expect(registry.dialectFor('analyzer')('shows')).toBe('horn-safe');
    expect(registry.dialectFor('insimul')('country')).toBe('grounding-only');
    expect(registry.dialectFor('insimul')('rule_applies')).toBe('full-prolog');
  });

  it('closes the producer→consumer loop with the real registry', async () => {
    const [fetch] = serving();
    const registry = await loadRelationRegistry(BASE, { fetch });
    const analyzer = registry.egressFor('analyzer');
    const pack = {
      assertions: [
        { id: 'a1', relation: 'shows' },
        { id: 'a2', relation: 'derived_from' },
        { id: 'a3', relation: 'scene' },
      ],
    };

    // A consumer rejects the unfiltered pack, and is told every record that disqualified it.
    expect(() => {
      assertPackEgress(pack, analyzer);
    }).toThrow(/§7.2/);

    // The producer's filter is what should have run first; what it emits then passes.
    const filtered = filterPackForEgress(pack, analyzer);
    expect(filtered.withheld.map((held) => held.record.id)).toEqual(['a1', 'a3']);
    expect(filtered.pack.assertions.map((record) => record.id)).toEqual(['a2']);
    expect(() => {
      assertPackEgress(filtered.pack, analyzer);
    }).not.toThrow();
  });
});
