/**
 * A snapshot of the real koine relation registry, for tests only.
 *
 * GENERATED — do not edit by hand. Regenerated verbatim from the koine sibling checkout by
 * `schemas/scripts/regen-koine-fixture.mjs` (`npm run -w @agora/schemas regen:koine-fixture`).
 * That regenerator is the ONLY supported way to refresh this fixture: a second AUTHORED copy of
 * the registry is how the registry forks (ADR-0001 — koine specifies, agora implements; agora
 * holds the tooling, not a copy), so the snapshot is derived from koine and never pasted in.
 *
 * The registry itself lives in koine and is fetched over the wire (`relation-registry.ts`);
 * nothing in `@agora/schemas`'s library surface reads what is here, and this module is exported
 * as `@agora/schemas/fixtures` (never from `./index.ts`) so it cannot become the vendored second
 * copy the registry exists to prevent. It is here because the validator has to be tested against
 * the *real* registry — a hand-written sample proves only that the validator accepts hand-written
 * samples.
 *
 * To refresh after a koine bump: run the regenerator. `--check` mode (`npm run -w @agora/schemas
 * regen:koine-fixture:check`) fails when the committed snapshot has drifted from koine.
 */
import mapping from './koine-registry/predicate-mapping.json';
import type { VocabularyFile } from '../registry-schema.ts';

/** `koine/registry/predicate-mapping.json` verbatim, typed as what it arrives as: unknown. */
export const KOINE_PREDICATE_MAPPING: unknown = mapping;

const CORE_RELATIONS = `relation	arity	arg_roles	symmetric	tier	domain	inverse	description
same_as	2	a|b	true	grounding-only	core		Identical referents; licenses fact transfer across the two ids (KINP §4.3)
based_on	2	derived|source	false	grounding-only	core		Lineage only; does NOT license fact transfer (the fiction→real firewall, KINP §4.3)
exact_match	2	a|b	true	grounding-only	core		Identity anchor to an external authority id (e.g. →wikidata:Q517)
part_of	2	part|whole	false	horn-safe	core	has_part	Mereological containment
instance_of	2	instance|class	false	horn-safe	core	has_instance	Type membership
co_occurs	2	a|b	true	grounding-only	core		Untyped co-occurrence of two entities
derived_from	2	derived|source	false	grounding-only	core		General derivation lineage
retracts	2	retraction|target	false	grounding-only	core		Lifecycle: withdraws a prior claim (KINP §4.2; additive, never deletes)
supersedes	2	newer|older	false	grounding-only	core		Lifecycle: replaces a prior claim with a newer one (KINP §4.2)
retrains	2	newer|older	false	grounding-only	core		Lifecycle: a re-train over the same pinned inputs mints a NEW model entity that retrains an earlier one (KFT §5.2); never a content-address id collision
located_in	2	entity|place	false	horn-safe	core	contains	Spatial containment: an entity is located in a place (positional, NOT mereological — cf. part_of)
descended_from	2	descendant|ancestor	false	horn-safe	core	ancestor_of	Genealogical/lineal descent (person, culture, language); the ancestor closure is one Horn rule
caused_by	2	effect|cause	false	horn-safe	core	causes	Event causality: the effect event happened because of the cause event
`;

const CINEMATOGRAPHY_RELATIONS = `relation	arity	arg_roles	symmetric	tier	domain	inverse	description
cine:shows	2	shot|subject	false	grounding-only	cine		A shot depicts a subject entity
cine:scene_of	2	shot|scene	false	grounding-only	cine	has_shot	A shot belongs to a scene
cine:says	2	speaker|utterance	false	grounding-only	cine		A speaker delivers an utterance (dialogue/narration)
cine:reads	2	frame|text	false	grounding-only	cine		Text (OCR/on-screen) read from a frame
cine:commands	2	commander|force	false	grounding-only	cine		Narrative: an entity commands a force (pressure-test example)
`;

const MEDIA_RELATIONS = `relation	arity	arg_roles	symmetric	tier	domain	inverse	description
media:derived_from	2	derived|source	false	grounding-only	media		B is a transcode/re-encode/render of A; B is its own asset (KMI §3)
media:variant_of	2	variant|source	false	grounding-only	media		B is a rendition of A at a different resolution/format/bitrate
media:excerpt_of	2	excerpt|source	false	grounding-only	media		B is a time/space sub-range of A (clip/crop/thumbnail); cut range on B's asset envelope
media:perceptual_match	2	a|b	true	grounding-only	media		Perceptual same-content signal (probabilistic); NEVER identity (KINP delta E)
media:mentions	2	asset|entity	false	grounding-only	media		An asset's text/transcript/caption refers to an entity by name — reference, not depiction (cf. cine:shows)
`;

const SOCIAL_RELATIONS = `relation	arity	arg_roles	symmetric	tier	domain	inverse	description
soc:parent_of	2	parent|child	false	horn-safe	soc	soc:child_of	Biological or adoptive parentage; the transitive ancestor chain is descended_from
soc:spouse_of	2	a|b	true	horn-safe	soc		Marriage or partnership between two persons (symmetric — operands sorted before hashing)
soc:employed_by	2	employee|employer	false	horn-safe	soc	soc:employs	A person is employed by a business or organisation
soc:resides_in	2	resident|residence	false	horn-safe	soc	soc:houses	A person dwells at a residence (occupancy, not mere position — cf. located_in)
`;

/** The vocabulary files, core first — the order the loader fetches them in. */
export const KOINE_VOCABULARY: readonly VocabularyFile[] = [
  { path: 'registry/relations.tsv', text: CORE_RELATIONS },
  { path: 'registry/relations/cinematography.tsv', text: CINEMATOGRAPHY_RELATIONS },
  { path: 'registry/relations/media.tsv', text: MEDIA_RELATIONS },
  { path: 'registry/relations/social.tsv', text: SOCIAL_RELATIONS },
];
