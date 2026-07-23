/**
 * Multi-provider `finetune` selection (KFT §8/§9, FT-K).
 *
 * More than one `finetune` provider can match a job — agora's **general** trainer and
 * Pinakes's **specialized** provider both accept `text-generation`. This is the registry
 * disambiguation the spec fixes (KCB §3):
 *
 *   1. A job MAY name a target provider explicitly — honored over any tiebreak.
 *   2. Otherwise prefer the more **specialized** matching provider (the narrower advertised
 *      finetune surface): a provider that serves one modality with a handful of methods is
 *      more specialized than the general trainer that serves five.
 *   3. Break a specialization tie by lower `cost` (delta K), priced before unpriced.
 *   4. An **unbroken** tie — equal specialization *and* equal cost — is **surfaced to the
 *      caller**, never resolved silently. Registration order is not a valid tiebreak here:
 *      which provider happened to register first says nothing about which should train.
 *
 * This is discovery, not routing: the winner is a {@link Match} carrying an address the
 * caller then dials directly (ADR-0001 decision 3). The registry never trains, never proxies.
 */
import type { Capability } from '@agora/schemas';

import { costOf } from './cost.ts';
import type { Match } from './registry.ts';

/** The job facets that decide which providers are candidates and how they rank (FT-K). */
export interface FinetuneJobSpec {
  /** KFT §3.1 modality — a provider must advertise a `finetune` capability serving it. */
  modality?: string;
  /** KFT §3.1 method — a candidate's matching capability must list it. */
  method?: string;
  /** An explicit target provider identity — honored over the tiebreak, if it serves the job. */
  provider?: string;
}

/** Why one provider won — or that the caller must choose. */
export type ProviderSelection =
  | { outcome: 'selected'; provider: Match; reason: SelectionReason }
  /** No indexed provider serves this job (unknown modality/method, or the named one is absent). */
  | { outcome: 'none' }
  /** Equally specialized *and* equally priced — the caller must pick (FT-K). */
  | { outcome: 'tie'; candidates: Match[] };

export type SelectionReason =
  /** The job named this provider and it serves the job. */
  | 'explicit'
  /** The only provider that serves the job. */
  | 'sole'
  /** Narrower advertised finetune surface than the runners-up (KCB §3). */
  | 'specialized'
  /** Equally specialized, but cheaper (delta K). */
  | 'cheaper';

/**
 * Pick a `finetune` provider from those that matched a discovery query.
 *
 * `matches` is the output of a `find({ capability: 'finetune', … })` — this narrows it to the
 * providers that actually serve `job`'s `modality`×`method` and applies the FT-K precedence.
 */
export function selectFinetuneProvider(
  matches: readonly Match[],
  job: FinetuneJobSpec = {},
): ProviderSelection {
  const candidates = matches.filter((match) => serves(match, job));

  // (1) An explicit target short-circuits — but only if it can actually serve the job.
  if (job.provider !== undefined) {
    const named = candidates.find((match) => match.identity === job.provider);
    return named
      ? { outcome: 'selected', provider: named, reason: 'explicit' }
      : { outcome: 'none' };
  }

  if (candidates.length === 0) return { outcome: 'none' };
  if (candidates.length === 1) {
    return { outcome: 'selected', provider: candidates[0]!, reason: 'sole' };
  }

  // (2)/(3) Most specialized first, then cheaper.
  const ranked = [...candidates].sort((a, b) => rank(a, b, job));
  const best = ranked[0]!;
  const runnerUp = ranked[1]!;

  // (4) An unbroken tie is surfaced — do not let registration order decide.
  if (tied(best, runnerUp, job)) {
    return { outcome: 'tie', candidates: ranked.filter((match) => tied(best, match, job)) };
  }

  const reason: SelectionReason = breadth(best) !== breadth(runnerUp) ? 'specialized' : 'cheaper';
  return { outcome: 'selected', provider: best, reason };
}

/** True when a provider advertises a `finetune` capability serving `job`'s modality×method. */
function serves(match: Match, job: FinetuneJobSpec): boolean {
  return finetuneCaps(match).some((capability) => {
    if (job.modality !== undefined && capability.modality !== job.modality) return false;
    if (job.method !== undefined && !(capability.methods ?? []).includes(job.method)) return false;
    return true;
  });
}

/**
 * How broad a provider's advertised `finetune` surface is — the (modality × method) count
 * across its `finetune` capabilities. Smaller is more specialized. A capability that lists no
 * methods still counts as one advertised route, so a bare-modality provider is not "narrower"
 * than one that spells its methods out.
 */
function breadth(match: Match): number {
  let total = 0;
  for (const capability of finetuneCaps(match)) {
    const methods = capability.methods ?? [];
    total += methods.length > 0 ? methods.length : 1;
  }
  return total;
}

/**
 * The projected cost of the capability that serves `job`'s modality — the ranking key once
 * specialization ties. Reads defensively: absent price ≠ free (delta K), so an unpriced
 * candidate ranks after every priced one.
 */
function cost(match: Match, job: FinetuneJobSpec): { estUnits: number; unpriced: boolean } {
  const relevant = finetuneCaps(match).filter(
    (capability) => job.modality === undefined || capability.modality === job.modality,
  );
  let best: { estUnits: number; unpriced: boolean } | undefined;
  for (const capability of relevant) {
    const { units, unpriced } = costOf(capability);
    const here = { estUnits: units, unpriced };
    if (best === undefined || cheaper(here, best)) best = here;
  }
  return best ?? { estUnits: 0, unpriced: true };
}

function rank(a: Match, b: Match, job: FinetuneJobSpec): number {
  const byBreadth = breadth(a) - breadth(b);
  if (byBreadth !== 0) return byBreadth;
  const ca = cost(a, job);
  const cb = cost(b, job);
  if (ca.unpriced !== cb.unpriced) return ca.unpriced ? 1 : -1;
  if (ca.estUnits !== cb.estUnits) return ca.estUnits - cb.estUnits;
  return a.registration.sequence - b.registration.sequence;
}

/** True when neither specialization nor cost separates two providers — an FT-K tie. */
function tied(a: Match, b: Match | undefined, job: FinetuneJobSpec): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  if (breadth(a) !== breadth(b)) return false;
  const ca = cost(a, job);
  const cb = cost(b, job);
  return ca.unpriced === cb.unpriced && ca.estUnits === cb.estUnits;
}

/** Priced beats unpriced; else cheaper units win (delta K). */
function cheaper(x: { estUnits: number; unpriced: boolean }, y: typeof x): boolean {
  if (x.unpriced !== y.unpriced) return !x.unpriced;
  return x.estUnits < y.estUnits;
}

function finetuneCaps(match: Match): Capability[] {
  return (match.registration.manifest.capabilities ?? []).filter((c) => c.name === 'finetune');
}
