import { describe, expect, it } from 'vitest';

import { KOINE_PREDICATE_MAPPING, KOINE_VOCABULARY } from './fixtures/koine-registry.ts';
import { RELATION_REGISTRY } from './relation-registry.ts';
import {
  assertRelationsResolve,
  assertSignatureStability,
  crossesAsClaim,
  diffSignatures,
  isRegistryDocument,
  parseRegistry,
  parseVocabulary,
  predicateNames,
  RegistryError,
  relationSignature,
  type MappingEntry,
  type RegistrySnapshot,
} from './registry-schema.ts';

/** The real registry, parsed once — every test here is a claim about the actual contract. */
const document = parseRegistry(KOINE_PREDICATE_MAPPING);
const relations = parseVocabulary(KOINE_VOCABULARY);
const registry: RegistrySnapshot = { document, relations };

function entriesOf(project: string): readonly MappingEntry[] {
  const mappings = document.projects[project];
  if (!mappings) throw new Error(`no such project: ${project}`);
  return mappings.relations;
}

/**
 * A mutable deep copy of the real registry. The validator takes `unknown`, so a draft is
 * modelled loosely on purpose — that is how a malformed registry arrives off the wire.
 */
interface Draft {
  registryVersion: string;
  projects: Record<string, { relations: Record<string, unknown>[] } | undefined>;
}

function draft(): Draft {
  return JSON.parse(JSON.stringify(document)) as Draft;
}

/** The draft's copy of a published entry, found by the id that entry is published under. */
function entry(from: Draft, project: string, id: number): Record<string, unknown> {
  const found = from.projects[project]?.relations.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no entry ${project}#${String(id)}`);
  return found;
}

/** The id of the first published entry matching `match` — so a test names a shape, not a row. */
function idOf(project: string, match: (candidate: MappingEntry) => boolean): number {
  const found = entriesOf(project).find(match);
  if (typeof found?.id !== 'number') throw new Error(`no matching entry in ${project}`);
  return found.id;
}

describe('the real koine registry', () => {
  it('is the registryVersion this build speaks', () => {
    // Guards the snapshot as much as the registry: a koine bump that skipped refreshing the
    // fixture lands here, in the same place the version bump itself does.
    expect(document.registryVersion).toBe(RELATION_REGISTRY.version);
  });

  it('validates as it ships — mappings and vocabulary together', () => {
    expect(isRegistryDocument(KOINE_PREDICATE_MAPPING)).toBe(true);
    expect(Object.keys(document.projects).sort()).toEqual([...RELATION_REGISTRY.bridgedProjects]);
    // One vocabulary: every relation a mapping normalizes to has a row of its own.
    expect(() => {
      assertRelationsResolve(document, relations);
    }).not.toThrow();
  });

  it('keeps the mapping layer from coining vocabulary', () => {
    // The rule that makes the two artifacts one registry: only a claim names relations.
    for (const project of RELATION_REGISTRY.bridgedProjects) {
      for (const published of entriesOf(project)) {
        expect(published.koineRelations.length > 0).toBe(crossesAsClaim(published.canonicalKind));
      }
    }
  });

  it('names a filterable predicate for everything it marks local-only', () => {
    // §7.2 is the producer's obligation, and a producer filters by predicate name. An entry
    // whose `external` is prose cannot be filtered, so it may not be local-only.
    const localOnly = RELATION_REGISTRY.bridgedProjects.flatMap((project) =>
      entriesOf(project).filter((published) => published.egress === 'local-only'),
    );
    expect(localOnly.length).toBeGreaterThan(0);
    for (const published of localOnly) {
      expect(predicateNames(published.external).length).toBeGreaterThan(0);
    }
  });

  it('parses the vocabulary into signable rows', () => {
    const names = relations.map((row) => row.relation);
    expect(names).toContain('same_as');
    expect(names).toContain('cine:shows');
    expect(names).toContain('soc:parent_of');
    expect(new Set(names).size).toBe(names.length);
    const parentOf = relations.find((row) => row.relation === 'soc:parent_of');
    expect(parentOf && relationSignature(parentOf)).toBe('soc:parent_of · 2 · parent|child · false');
    // An inverse is a reading, not a relation: it is named but never given a row.
    expect(names).not.toContain('soc:child_of');
  });
});

describe('parseRegistry', () => {
  it('refuses a registryVersion it does not speak', () => {
    // 0.2.0 still says `portability: [...]`; reading it as 0.4.0 would read `local-only` as a
    // dialect tier, which is precisely the conflation US-SRR2 removed.
    const old = draft();
    old.registryVersion = '0.2.0';
    expect(() => parseRegistry(old)).toThrow(RegistryError);
  });

  it('rejects a malformed entry', () => {
    const shows = idOf('analyzer', (candidate) => candidate.external.startsWith('shows('));

    const badKind = draft();
    entry(badKind, 'analyzer', shows).canonicalKind = 'relationship';
    expect(() => parseRegistry(badKind)).toThrow(/canonicalKind/);

    const badEgress = draft();
    entry(badEgress, 'analyzer', shows).egress = 'maybe';
    expect(() => parseRegistry(badEgress)).toThrow(/egress/);

    // `local-only` as a dialect is the 0.2.0 conflation, and it is not readable as a tier.
    const badDialect = draft();
    entry(badDialect, 'analyzer', shows).dialect = 'local-only';
    expect(() => parseRegistry(badDialect)).toThrow(/dialect/);

    const badDirection = draft();
    entry(badDirection, 'analyzer', shows).direction = 'AR<->LS';
    expect(() => parseRegistry(badDirection)).toThrow(/direction/);

    const badPending = draft();
    entry(badPending, 'analyzer', shows).pending = 'no';
    expect(() => parseRegistry(badPending)).toThrow(/pending/);

    const collided = draft();
    entry(collided, 'analyzer', shows).id = idOf('analyzer', (candidate) => candidate.id !== shows);
    expect(() => parseRegistry(collided)).toThrow(/two entries with id/);
  });

  it('rejects a claim entry that names no relation, and a non-claim that names one', () => {
    const silent = draft();
    entry(silent, 'analyzer', idOf('analyzer', (c) => c.canonicalKind === 'edge')).koineRelations = [];
    expect(() => parseRegistry(silent)).toThrow(/crosses as a claim/);

    const coining = draft();
    entry(coining, 'insimul', idOf('insimul', (c) => c.canonicalKind === 'node')).koineRelations = [
      'same_as',
    ];
    expect(() => parseRegistry(coining)).toThrow(/must be empty/);
  });

  it('rejects a local-only entry a producer could not filter', () => {
    const prose = draft();
    entry(prose, 'analyzer', idOf('analyzer', (c) => c.egress === 'local-only')).external =
      'technical metadata about the file';
    expect(() => parseRegistry(prose)).toThrow(/local-only but names no machine-readable/);
  });

  it('rejects a projects block that carries the canonical project or an unknown one', () => {
    const forked = draft();
    forked.projects.pinakes = forked.projects.analyzer;
    expect(() => parseRegistry(forked)).toThrow(/canonical side/);

    const partial = draft();
    partial.projects = { analyzer: partial.projects.analyzer };
    expect(() => parseRegistry(partial)).toThrow(/missing the bridged project insimul/);
  });

  it('rejects a mapping that names a relation the vocabulary does not have', () => {
    const invented = draft();
    entry(invented, 'insimul', idOf('insimul', (c) => c.canonicalKind === 'edge')).koineRelations = [
      'soc:befriends',
    ];
    expect(() => {
      assertRelationsResolve(parseRegistry(invented), relations);
    }).toThrow(/add it to the TSV/);
  });
});

describe('parseVocabulary', () => {
  const header = KOINE_VOCABULARY[0]?.text.split('\n')[0] ?? '';

  function withRow(row: string) {
    return [{ path: 'test.tsv', text: `${header}\n${row}` }];
  }

  it('rejects a row that dropped a tab', () => {
    // The empty `inverse` column is two tabs; an edit that collapses them yields 7 columns.
    expect(() =>
      parseVocabulary(withRow('likes\t2\ta|b\tfalse\thorn-safe\tcore\tSomeone likes someone')),
    ).toThrow(/tab-separated columns/);
  });

  it('rejects an arity that disagrees with the roles, and a tier that is not one', () => {
    expect(() =>
      parseVocabulary(withRow('likes\t3\ta|b\tfalse\thorn-safe\tcore\t\tArity lies')),
    ).toThrow(/arg_roles/);
    expect(() =>
      parseVocabulary(withRow('likes\t2\ta|b\tfalse\tlocal-only\tcore\t\tNot a dialect tier')),
    ).toThrow(/dialect tier/);
  });

  it('rejects a symmetric relation that claims an inverse', () => {
    expect(() =>
      parseVocabulary(withRow('likes\t2\ta|b\ttrue\thorn-safe\tcore\tliked_by\tIts own inverse')),
    ).toThrow(/its own inverse/);
  });

  it('rejects a domain that disagrees with the namespace, and a duplicate name', () => {
    expect(() =>
      parseVocabulary(withRow('cine:pans\t2\tshot|subject\tfalse\thorn-safe\tcore\t\tWrong domain')),
    ).toThrow(/disagrees with the relation's namespace/);
    const twice = KOINE_VOCABULARY[3];
    expect(twice).toBeDefined();
    expect(() => parseVocabulary([...KOINE_VOCABULARY, ...(twice ? [twice] : [])])).toThrow(
      /declared twice/,
    );
  });

  it('rejects an inverse that also has a row of its own', () => {
    const forked = KOINE_VOCABULARY.map((file) =>
      file.path.endsWith('social.tsv')
        ? {
            ...file,
            text: `${file.text}soc:child_of\t2\tchild|parent\tfalse\thorn-safe\tsoc\t\tThe inverse, again\n`,
          }
        : file,
    );
    expect(() => parseVocabulary(forked)).toThrow(/an inverse is a reading of a relation/);
  });
});

describe('predicateNames', () => {
  it('reads the machine-readable forms and refuses to guess at prose', () => {
    expect(predicateNames('country/1, government_type/2')).toEqual(['country', 'government_type']);
    // The comma inside the parentheses does not split the token.
    expect(predicateNames('shows(asset, X)')).toEqual(['shows']);
    expect(predicateNames('asset_technical')).toEqual(['asset_technical']);
    // An indicator at the head of the token counts; a note after it is still prose.
    expect(predicateNames('married_to/2 (spouseId)')).toEqual(['married_to']);
    expect(predicateNames('cinematography facts/violations')).toEqual([]);
    expect(predicateNames('lineage chains over parent_of/2 · child_of/2')).toEqual([]);
    // Nor does one inside braces — `source_url` is a field of a record, not a predicate.
    expect(predicateNames('fact provenance {source, source_url, confidence}')).toEqual([]);
  });
});

describe('signature immutability', () => {
  it('accepts the registry against itself, and accepts additions', () => {
    expect(diffSignatures(registry, registry)).toEqual([]);
    const grown: RegistrySnapshot = {
      document,
      relations: [
        ...relations,
        {
          relation: 'soc:befriends',
          arity: 2,
          argRoles: ['a', 'b'],
          symmetric: true,
          tier: 'horn-safe',
          domain: 'soc',
          description: 'A new name is how a signature is meant to evolve',
          source: 'registry/relations/social.tsv',
        },
      ],
    };
    expect(() => {
      assertSignatureStability(registry, grown);
    }).not.toThrow();
  });

  it('rejects a signature-changing edit to a published relation', () => {
    // Swapping the roles of `soc:parent_of` re-hashes every parentage claim ever minted.
    const swapped: RegistrySnapshot = {
      document,
      relations: relations.map((row) =>
        row.relation === 'soc:parent_of' ? { ...row, argRoles: ['child', 'parent'] } : row,
      ),
    };
    expect(diffSignatures(registry, swapped)).toEqual([
      {
        kind: 'relation',
        name: 'soc:parent_of',
        published: 'soc:parent_of · 2 · parent|child · false',
        candidate: 'soc:parent_of · 2 · child|parent · false',
      },
    ]);
    expect(() => {
      assertSignatureStability(registry, swapped);
    }).toThrow(/claim id/);
  });

  it('rejects an arity change, even where the roles still line up', () => {
    const widened: RegistrySnapshot = {
      document,
      relations: relations.map((row) =>
        row.relation === 'co_occurs' ? { ...row, arity: 3, argRoles: ['a', 'b', 't'] } : row,
      ),
    };
    expect(() => {
      assertSignatureStability(registry, widened);
    }).toThrow(RegistryError);
  });

  it('rejects a mapping entry retargeted in place', () => {
    // A published entry's `external` is stable too: retarget by superseding, never by
    // rewriting, or the producer's filter and the consumer's disagree about what it covers.
    const shows = idOf('analyzer', (candidate) => candidate.external.startsWith('shows('));
    const edited = draft();
    entry(edited, 'analyzer', shows).external = 'depicts(asset, X)';
    expect(diffSignatures(registry, { document: parseRegistry(edited), relations })).toEqual([
      {
        kind: 'mapping-entry',
        name: `analyzer#${String(shows)}`,
        published: 'shows(asset, X)',
        candidate: 'depicts(asset, X)',
      },
    ]);
  });
});
