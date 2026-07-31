/**
 * The cross-plane assertion vocabulary — KCS §5.
 *
 * "Assertions are what make a scenario a *conformance test* rather than a demo." Every
 * predicate §5 names is declared here; a predicate with no evaluator returns **pending**,
 * which counts as *not passing*.
 *
 * That is the load-bearing decision in this file. If an unknown predicate were skipped, a
 * scenario asserting `firewall_holds` would go green on a console that has never checked a
 * firewall — the same failure mode as the registry reading an unpriced route as free. So
 * the vocabulary is a closed list, an unimplemented name is pending rather than absent,
 * and the report shows it. Today every §5 name has an evaluator; the mechanism stays
 * because a future KCS revision that adds one must land as a visible gap, not a silence.
 *
 * Evaluators read the **observation log** (§4.3), not the runner's internals and never a
 * model's prose: §7 Q2 says a scenario asserts structure and invariants, so a verdict here
 * is computed from plane-typed records a peer stated ({@link ./facts.ts}) and carries the
 * slice of traffic that supports it. A provider that describes the right answer in English
 * fails every predicate below, which is the intent.
 */
import type { CapabilityRegistry, PortQuery } from '@agora/registry';
import { isJsonObject, type Json, type ScenarioDocument } from '@agora/schemas';

import {
  LINEAGE_RELATIONS,
  LINK_RELATIONS,
  worldOf,
  type ObservedAsset,
  type ObservedClaim,
} from './facts.ts';
import type { Observation, ObservationLog, Sighting } from './log.ts';
import type { StepOutcome } from './outcome.ts';

export interface AssertionContext {
  scenario: ScenarioDocument;
  outcomes: ReadonlyMap<string, StepOutcome>;
  log: ObservationLog;
  registry: CapabilityRegistry;
}

export interface AssertionVerdict {
  ok: boolean;
  /** True when the predicate is spec'd but not implemented here — never a pass. */
  pending?: boolean;
  detail: string;
  /** The log slice that supports the verdict (§4.4). */
  support: Observation[];
}

export type Evaluator = (args: Json[], context: AssertionContext) => AssertionVerdict;

/**
 * The §5 vocabulary, by plane. The test suite asserts this list still matches the spec's,
 * so a KCS revision that adds a predicate shows up as a failing gate rather than as a
 * silently-ignored assertion.
 */
export const ASSERTION_PLANES: Record<string, readonly string[]> = {
  identity: ['no_sameas_across_worlds', 'based_on_exists', 'resolves_to', 'firewall_holds'],
  knowledge: ['claim_in_world', 'claims_converge', 'provenance_present'],
  media: ['asset_attaches_to', 'source_world_is', 'analysis_attributed_to_constituent'],
  control: [
    'capability_path_exists',
    'cost_within_ceiling',
    'tier_resolved',
    'dangling_ref_tolerated',
    'refused',
  ],
  liveness: ['completes', 'always_completes'],
};

/** Every predicate §5 names, in declaration order. */
export const ASSERTION_NAMES: readonly string[] = Object.values(ASSERTION_PLANES).flat();

const EVALUATORS: Record<string, Evaluator> = {
  completes(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    return {
      ok: outcome.status === 'passed' && outcome.refused === undefined,
      detail: `${id} ${outcome.status}${outcome.error === undefined ? '' : `: ${outcome.error}`}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * The zero-spend property, scenario-wide: every step that was meant to succeed did.
   * Takes no argument — `always_completes(scenario)` is about the run, not a step.
   */
  always_completes(_args, context) {
    const failed = [...context.outcomes.values()].filter(
      (outcome) => outcome.kind !== 'assert' && outcome.status !== 'passed',
    );
    return {
      ok: failed.length === 0,
      detail:
        failed.length === 0
          ? `all ${context.outcomes.size} steps completed`
          : `${failed.map((outcome) => outcome.id).join(', ')} did not complete`,
      support: context.log.entries().slice(),
    };
  },

  tier_resolved(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    const expected = args[1];
    const actual = outcome.result?.tier;
    return {
      ok: actual !== undefined && actual === expected,
      detail: `${id} resolved to tier ${String(actual)}, expected ${String(expected)}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * A ceiling is a promise about spend, so this reads the **actual** units the provider
   * reported, and the projection too: a route that projected over the ceiling and got
   * lucky is still a broken gate. An unreported cost fails — silence is not zero (US-AG3).
   */
  cost_within_ceiling(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    const ceiling = args[1];
    const cost = outcome.result?.cost;
    if (typeof ceiling !== 'number') {
      return { ok: false, detail: `cost_within_ceiling needs a numeric ceiling`, support: [] };
    }
    if (cost === undefined) {
      return {
        ok: false,
        detail: `${id} reported no cost — an unreported cost is not a zero cost`,
        support: context.log.forStep(id),
      };
    }
    return {
      ok: cost.actual_units <= ceiling && cost.projected_units <= ceiling,
      detail: `${id} projected ${cost.projected_units} / spent ${cost.actual_units} ${cost.currency} against a ceiling of ${ceiling}`,
      support: context.log.forStep(id),
    };
  },

  /** Delta O: the step declared `expect: reject` and the provider did refuse it. */
  refused(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    return {
      ok: outcome.expected === 'reject' && outcome.refused !== undefined,
      detail:
        outcome.refused === undefined
          ? `${id} was not refused`
          : `${id} refused with ${outcome.refused.status}: ${outcome.refused.reason}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * KCB §3 composition: the registry can *describe* a route from one port to another.
   * Args are port queries, e.g. `[{"plane":"knowledge","shape":"chat-messages"},
   * {"plane":"knowledge","shape":"completion-text"}]`.
   */
  capability_path_exists(args, context) {
    const [from, to] = args;
    if (!isJsonObject(from) || !isJsonObject(to)) {
      return { ok: false, detail: 'capability_path_exists needs two port queries', support: [] };
    }
    const path = context.registry.path({ from: from as PortQuery, to: to as PortQuery });
    return {
      ok: path !== undefined,
      detail:
        path === undefined
          ? `no path from ${JSON.stringify(from)} to ${JSON.stringify(to)}`
          : `${path.steps.map((s) => `${s.identity}/${s.capability}`).join(' → ')} (${path.projectedUnits} units)`,
      support: [],
    };
  },

  /**
   * KGP §2/§7: the claim landed in the world it was supposed to, and only there.
   *
   * A claim whose producer stated **no** world fails. KGP §3.2 rule 4 lets a producer
   * default an unstated world to its own — which means the console cannot tell where such
   * a claim landed, and "cannot tell" must not read as "correct" in the predicate the
   * firewall is built on.
   */
  claim_in_world(args, context) {
    const [reference, world] = args;
    const seen = matchClaims(reference, context);
    if (seen.length === 0) return unseen('claim', reference, context);
    const stray = seen.filter((sighting) => sighting.value.world !== world);
    return {
      ok: stray.length === 0,
      detail:
        stray.length === 0
          ? `all ${seen.length} observation(s) of ${describe(reference)} are in ${String(world)}`
          : `${describe(reference)} was also observed in ${list(
              stray.map((sighting) => sighting.value.world ?? 'no stated world'),
            )}`,
      support: support(stray.length === 0 ? seen : stray),
    };
  },

  /**
   * KGP §3.1: two references are the *same* claim once their entities reconcile — the
   * dedup that content-addressing exists for. Convergence is therefore an identity check
   * on the claim id, never a similarity judgement about the text.
   */
  claims_converge(args, context) {
    const [left, right] = args;
    const ours = claimIds(left, context);
    const theirs = claimIds(right, context);
    const shared = [...ours].filter((id) => theirs.has(id));
    if (ours.size === 0 || theirs.size === 0) {
      return {
        ok: false,
        detail: `no content-addressed id was observed for ${describe(
          ours.size === 0 ? left : right,
        )} — claims cannot be shown to converge`,
        support: support([...matchClaims(left, context), ...matchClaims(right, context)]),
      };
    }
    return {
      ok: shared.length > 0,
      detail:
        shared.length > 0
          ? `both reduced to ${shared.join(', ')}`
          : `${[...ours].join(', ')} and ${[...theirs].join(', ')} are distinct claim ids`,
      support: support([...matchClaims(left, context), ...matchClaims(right, context)]),
    };
  },

  /** KINP §7.1: the claim says who asserted it. "Who told us this" must be answerable. */
  provenance_present(args, context) {
    const [reference] = args;
    const seen = matchClaims(reference, context);
    if (seen.length === 0) return unseen('claim', reference, context);
    const bare = seen.filter((sighting) => typeof sighting.value.prov?.agent !== 'string');
    return {
      ok: bare.length === 0,
      detail:
        bare.length === 0
          ? `every observation of ${describe(reference)} carries prov.agent`
          : `${bare.length} of ${seen.length} observation(s) of ${describe(
              reference,
            )} carry no prov.agent`,
      support: support(bare.length === 0 ? seen : bare),
    };
  },

  /**
   * KINP §4.3/§4.5 — the firewall, stated as an identity rule: an equivalence that would
   * license facts to flow between two worlds must not exist. Cross-world lineage is
   * `based_on` (no inference), and delta C is explicit that transitivity never promotes
   * a `based_on` chain to `same_as` — so the closure walked here is over `same_as` alone.
   */
  no_sameas_across_worlds(args, context) {
    const [a, b] = args;
    const sameAs = context.log
      .linksSeen()
      .filter((sighting) => sighting.value.relation === 'same_as');
    const reached = closure(String(a), sameAs.map((sighting) => sighting.value));
    const crossed = reached.has(String(b)) && worldOf(a) !== worldOf(b);
    return {
      ok: !crossed,
      detail: crossed
        ? `same_as links ${String(a)} (${worldOf(a) ?? 'no world'}) to ${String(b)} (${
            worldOf(b) ?? 'no world'
          }) — cross-world equivalence must be based_on (KINP §4.5)`
        : `no same_as path joins ${String(a)} and ${String(b)} across worlds`,
      support: support(sameAs),
    };
  },

  /** KINP §4.3: the lineage link that records "modeled on" without licensing inference. */
  based_on_exists(args, context) {
    const [a, b] = args;
    const seen = context.log
      .linksSeen()
      .filter(
        (sighting) =>
          sighting.value.relation === 'based_on' &&
          sighting.value.from === a &&
          sighting.value.to === b,
      );
    return {
      ok: seen.length > 0,
      detail:
        seen.length > 0
          ? `based_on(${String(a)}, ${String(b)}) was observed`
          : `no based_on link from ${String(a)} to ${String(b)} was observed`,
      support: support(seen),
    };
  },

  /**
   * "Facts about a baseline X never return scoped-world claims" (§5), evaluated over what a query
   * step actually returned: every claim it produced is in the named world.
   *
   * The world is named by the assertion rather than inferred, because a world's
   * inheritance policy is per-world metadata (KINP §5) the console does not hold — and
   * inferring it is precisely the kind of guess a firewall test must not make. A query
   * that returned nothing passes and says so; the scenario asserts `completes` for the
   * other half.
   */
  firewall_holds(args, context) {
    const [id, outcome] = step(args, context);
    const world = args[1];
    if (outcome === undefined) return miss(id, context);
    if (outcome.status !== 'passed') {
      return {
        ok: false,
        detail: `${id} ${outcome.status} — a query that did not run proves no firewall`,
        support: context.log.forStep(id),
      };
    }
    const claims = context.log.factsForStep(id).claims;
    const leaked = claims.filter((claim) => claim.world !== world);
    return {
      ok: leaked.length === 0,
      detail:
        leaked.length === 0
          ? `${id} returned ${claims.length} claim(s), all in ${String(world)}`
          : `${id} returned ${leaked.length} claim(s) from ${list(
              leaked.map((claim) => claim.world ?? 'no stated world'),
            )} — ${String(world)} was asked`,
      support: context.log.forStep(id),
    };
  },

  /** KINP §7.2: media hangs off entities by identifier, and this one hangs off that one. */
  asset_attaches_to(args, context) {
    const [id, entity] = args;
    const seen = assetsWithId(id, context);
    if (seen.length === 0) return unseen('asset', id, context);
    const attached = seen.filter((sighting) =>
      sighting.value.attaches_to.includes(String(entity)),
    );
    return {
      ok: attached.length > 0,
      detail:
        attached.length > 0
          ? `${String(id)} attaches to ${String(entity)}`
          : `${String(id)} attaches to ${list(
              seen.flatMap((sighting) => sighting.value.attaches_to),
            )} — not ${String(entity)}`,
      support: support(attached.length > 0 ? attached : seen),
    };
  },

  /**
   * KMI delta H: an ingested asset that depicts a world declares it; a generated one
   * declares `null`. An envelope that declares neither is a *failure*, not a null — the
   * silence is what would let extracted knowledge land in the baseline world by default.
   */
  source_world_is(args, context) {
    const [id, world] = args;
    const seen = assetsWithId(id, context);
    if (seen.length === 0) return unseen('asset', id, context);
    const stated = seen.filter((sighting) => sighting.value.source_world !== undefined);
    if (stated.length === 0) {
      return {
        ok: false,
        detail: `${String(id)} stated no source_world — KMI delta H requires one at ingest`,
        support: support(seen),
      };
    }
    const wrong = stated.filter((sighting) => sighting.value.source_world !== world);
    return {
      ok: wrong.length === 0,
      detail:
        wrong.length === 0
          ? `${String(id)} declares source_world ${JSON.stringify(world)}`
          : `${String(id)} declares source_world ${list(
              wrong.map((sighting) => JSON.stringify(sighting.value.source_world)),
            )}, not ${JSON.stringify(world)}`,
      support: support(wrong.length === 0 ? stated : wrong),
    };
  },

  /**
   * KMI §5 delta H: analysis of a *composite* is attributed to its constituents' worlds,
   * traced through the lineage links — never to the composite's own. A render has
   * `source_world: null`, so scoping its analysis to the composite would drop every claim
   * out of the scoped world it actually came from, and the firewall would fail open.
   */
  analysis_attributed_to_constituent(args, context) {
    const [id] = args;
    const composite = String(id);
    const seen = assetsWithId(composite, context);
    if (seen.length === 0) return unseen('asset', id, context);
    const parts = constituentsOf(composite, context);
    if (parts.length === 0) {
      return {
        ok: false,
        detail: `no constituent of ${composite} was observed — nothing to attribute to`,
        support: support(seen),
      };
    }
    const worlds = new Set(
      parts.flatMap((part) => {
        const stated = assetsWithId(part, context)
          .map((sighting) => sighting.value.source_world)
          .filter((world): world is string => typeof world === 'string');
        const named = worldOf(part);
        return named === undefined ? stated : [...stated, named];
      }),
    );
    if (worlds.size === 0) {
      // Every constituent is itself generated. Reporting this as a *misattribution* would
      // read as "the claims went to the wrong world" when the truth is that the lineage
      // walk never reached an ingested asset — which is a broken graph, not a broken scope.
      return {
        ok: false,
        detail: `no constituent of ${composite} (${list(parts)}) states a source_world — its analysis is attributable to no world`,
        support: support(seen),
      };
    }
    // Analysis, not lineage: a `media:excerpt_of` also has the composite as its subject,
    // but it is an edge in the asset graph (KMI §3) and carries no world of its own. Only
    // the domain claims analysis produced are attributable.
    const analysis = context.log
      .claimsSeen()
      .filter(
        (sighting) =>
          !LINK_RELATIONS.includes(sighting.value.relation) &&
          (sighting.value.subject === composite || sighting.value.object === composite),
      );
    if (analysis.length === 0) {
      return {
        ok: false,
        detail: `no claim about ${composite} was observed — nothing was attributed`,
        support: support(seen),
      };
    }
    const misattributed = analysis.filter(
      (sighting) => sighting.value.world === undefined || !worlds.has(sighting.value.world),
    );
    return {
      ok: misattributed.length === 0,
      detail:
        misattributed.length === 0
          ? `${analysis.length} claim(s) about ${composite} land in its constituents' world(s) ${list(
              [...worlds],
            )}`
          : `${misattributed.length} claim(s) about ${composite} land in ${list(
              misattributed.map((sighting) => sighting.value.world ?? 'no stated world'),
            )}, not in ${list([...worlds])}`,
      support: support(misattributed.length === 0 ? analysis : misattributed),
    };
  },

  /**
   * KCB delta L: a reference may arrive before its bytes propagate, so a consumer must
   * `fetch` lazily and *tolerate* the miss. Tolerance is only demonstrated by a run that
   * met one and carried on — hence both halves: the log shows the dangling fetch, and the
   * step that made it did not fail the run.
   */
  dangling_ref_tolerated(args, context) {
    const [id] = args;
    const ref = String(id);
    const sightings = context.log
      .assetsSeen()
      .filter((sighting) => sighting.value.id === ref && !sighting.value.present);
    if (sightings.length === 0) {
      return {
        ok: false,
        detail: `no fetch of ${ref} came back missing — nothing was tolerated`,
        support: context.log.assetsSeen().filter((sighting) => sighting.value.id === ref).map(
          (sighting) => sighting.entry,
        ),
      };
    }
    const broke = sightings.filter(
      (sighting) => context.outcomes.get(sighting.entry.step)?.status === 'failed',
    );
    return {
      ok: broke.length === 0,
      detail:
        broke.length === 0
          ? `${ref} was dangling and the run carried on`
          : `${ref} was dangling and ${list(broke.map((sighting) => sighting.entry.step))} failed on it`,
      support: support(broke.length === 0 ? sightings : broke),
    };
  },

  /** KINP §8: a `resolve` step turned `local` into `canonical`. Read off the log. */
  resolves_to(args, context) {
    const [local, canonical] = args;
    const support = context.log
      .entries()
      .filter(
        (entry) =>
          entry.direction === 'response' &&
          entry.detail.resolved === local &&
          entry.detail.id === canonical,
      );
    return {
      ok: support.length > 0,
      detail:
        support.length > 0
          ? `${String(local)} resolved to ${String(canonical)}`
          : `no observation resolves ${String(local)} to ${String(canonical)}`,
      support,
    };
  },
};

/** Evaluate one §5 predicate. An unknown or unimplemented name never passes. */
export function evaluateAssertion(
  predicate: string,
  args: Json[],
  context: AssertionContext,
): AssertionVerdict {
  const evaluator = EVALUATORS[predicate];
  if (evaluator !== undefined) return evaluator(args, context);
  if (ASSERTION_NAMES.includes(predicate)) {
    return {
      ok: false,
      pending: true,
      detail: `${predicate} is KCS §5 vocabulary this build cannot evaluate yet`,
      support: [],
    };
  }
  return { ok: false, detail: `${predicate} is not a KCS §5 predicate`, support: [] };
}

/** True when this build can actually evaluate `predicate` (the console's own doctor). */
export function isImplemented(predicate: string): boolean {
  return EVALUATORS[predicate] !== undefined;
}

function step(args: Json[], context: AssertionContext): [string, StepOutcome | undefined] {
  const id = String(args[0]);
  return [id, context.outcomes.get(id)];
}

function miss(id: string, context: AssertionContext): AssertionVerdict {
  return { ok: false, detail: `no step ${id} ran`, support: context.log.forStep(id) };
}

/**
 * How a scenario names a claim it wants to assert about.
 *
 * Three forms, because three things are natural to write: the content-addressed id (or a
 * `${step.claims.0}` binding to one), a bare relation name when the scenario cares that
 * *some* `commands(…)` claim landed, or a pattern object matching any stated field. What
 * is never a form: prose. A claim is matched on its plane-typed fields or not at all.
 */
function matchClaims(reference: Json | undefined, context: AssertionContext): Sighting<ObservedClaim>[] {
  const seen = context.log.claimsSeen();
  if (typeof reference === 'string') {
    const byId = seen.filter((sighting) => sighting.value.id === reference);
    if (byId.length > 0) return byId;
    return seen.filter((sighting) => sighting.value.relation === reference);
  }
  if (!isJsonObject(reference)) return [];
  return seen.filter((sighting) => {
    const claim = sighting.value;
    for (const [key, wanted] of Object.entries(reference)) {
      const actual = (claim as unknown as Record<string, Json | undefined>)[key];
      if (actual !== wanted) return false;
    }
    return true;
  });
}

/** The content-addressed ids a claim reference resolves to (KGP §2.1/§3). */
function claimIds(reference: Json | undefined, context: AssertionContext): Set<string> {
  const ids = new Set<string>();
  if (typeof reference === 'string' && reference.includes(':claim:')) ids.add(reference);
  for (const sighting of matchClaims(reference, context)) {
    if (sighting.value.id !== undefined) ids.add(sighting.value.id);
  }
  return ids;
}

function assetsWithId(id: Json | undefined, context: AssertionContext): Sighting<ObservedAsset>[] {
  return context.log.assetsSeen().filter((sighting) => sighting.value.id === id);
}

/**
 * Every asset the log says this one was made from (KMI §3 lineage + `excerpt.source`),
 * followed **transitively** through the lineage graph.
 *
 * KMI §5 says a composite's analysis is attributed to its constituent clips' worlds
 * "traced via `media:excerpt_of` / `media:derived_from`", and a real edit puts more than one
 * link between the two: a render is derived from an EDL, the EDL from the clips, the clips
 * excerpted from an ingested master. Only the master and the clips carry a `source_world` —
 * every intermediate is generated and declares `null` — so a one-hop walk would find no
 * world at all and the firewall check would have nothing to check. KMI is explicit that a
 * composite's provenance is "the union over its lineage graph"; this is that union.
 */
function constituentsOf(composite: string, context: AssertionContext): string[] {
  const parts = new Set<string>();
  const frontier = [composite];
  const walked = new Set<string>([composite]);
  while (frontier.length > 0) {
    const asset = frontier.pop() as string;
    const found: string[] = [];
    for (const sighting of assetsWithId(asset, context)) found.push(...sighting.value.constituents);
    for (const sighting of context.log.linksSeen()) {
      const link = sighting.value;
      if (LINEAGE_RELATIONS.includes(link.relation) && link.from === asset) found.push(link.to);
    }
    for (const part of found) {
      parts.add(part);
      // A cycle in the lineage graph is somebody's bug, not this walk's problem to report.
      if (!walked.has(part)) {
        walked.add(part);
        frontier.push(part);
      }
    }
  }
  return [...parts];
}

/** Everything reachable from `start` over a set of undirected links. */
function closure(start: string, links: { from: string; to: string }[]): Set<string> {
  const reached = new Set<string>([start]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const link of links) {
      for (const [near, far] of [
        [link.from, link.to],
        [link.to, link.from],
      ] as const) {
        if (reached.has(near) && !reached.has(far)) {
          reached.add(far);
          grew = true;
        }
      }
    }
  }
  return reached;
}

/** The log slice behind a verdict, deduplicated and in observation order. */
function support(sightings: Sighting<unknown>[]): Observation[] {
  const entries = new Map<number, Observation>();
  for (const sighting of sightings) entries.set(sighting.entry.seq, sighting.entry);
  return [...entries.values()].sort((a, b) => a.seq - b.seq);
}

function unseen(what: string, reference: Json | undefined, context: AssertionContext): AssertionVerdict {
  return {
    ok: false,
    detail: `no ${what} matching ${describe(reference)} was observed`,
    support: context.log.entries().slice(),
  };
}

function describe(reference: Json | undefined): string {
  return typeof reference === 'string' ? reference : JSON.stringify(reference);
}

function list(values: readonly string[]): string {
  return [...new Set(values)].join(', ');
}
