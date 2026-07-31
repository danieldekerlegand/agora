/**
 * The live fabric monitor — a **passive** observer of traffic the console did not initiate.
 *
 * The scenario runner and the capability explorer both *drive* the fabric: they compose a
 * request and watch what comes back. This does neither. It registers as a consumer on the
 * streams providers already publish and renders what crosses them, whoever caused it.
 *
 * ## What ADR-0001 allows, and what it therefore cannot see
 *
 * Decision 7 makes the console an observer on real connections, never a hub — and a hub is
 * exactly what a monitor would become if it sat between two peers and read their traffic. So
 * the monitor may only see what a peer *publishes to it*, and that splits cleanly in two:
 *
 * * **Data plane — covered today, with no new contract.** KCB §4's `subscribe` is a
 *   first-class verb: a consumer registers for a world or capability and receives KGP deltas
 *   (KGP §6) and media events as they occur. The monitor subscribes as one consumer among
 *   many, and every delta another platform publishes shows up whether the console asked for
 *   the work or not. {@link FabricMonitor.sweep} is that registration.
 * * **Control plane — only what a provider emits.** There is no way to observe an `invoke`
 *   between two other peers without tapping their wire, which is the proxy this topology
 *   forbids. The monitor therefore renders exchange telemetry when a provider *emits* it on
 *   its own stream (`kcs/spans.ts`), and **a provider that emits nothing is simply absent at
 *   the invoke level**. That is a documented limitation of the current contracts, not of this
 *   implementation: full control-plane visibility needs an emitted-telemetry contract in
 *   koine (a KCB observability extension — the follow-up named in the 30-* tasklist).
 *
 * {@link describeMonitor} states both, and `monitor.test.ts` asserts the class has no verb
 * that could originate work — the same way the registry's "never proxies" is asserted rather
 * than merely written down.
 */
import type { CapabilityRegistry, Registration } from '@agora/registry';
import type { CapabilityManifest, Json } from '@agora/schemas';

import { platformFetch, type HttpFetch } from '../kcs/http.ts';
import { openLink, VERB_ENDPOINTS, type Peer } from '../kcs/link.ts';
import { ObservationLog } from '../kcs/log.ts';
import { parseFixture, Standin, type StandinFixture } from '../kcs/standin.ts';
import { eventsFrom, type FabricEvent } from './feed.ts';

/** The monitor's own KINP identity — it is a participant on the bus like any consumer. */
export const MONITOR_IDENTITY = 'agora:agent:monitor';

/** The log `step` every monitored frame is recorded under. */
export const MONITOR_STEP = 'monitor';

/** One stream the monitor is registered on. */
export interface MonitorSource {
  identity: string;
  /** The worlds it will be asked for. Empty means "the whole stream", KCB §4's other form. */
  worlds: string[];
  /** The address subscribed to, when the peer published one. */
  endpoint?: string | undefined;
  /** The fixture standing in for a peer that has not adopted the bus (KCS delta N). */
  standin?: string | undefined;
  /** True once a sweep has seen this peer emit exchange telemetry — see the module note. */
  emitsTelemetry: boolean;
}

export interface MonitorOptions {
  /** The console's own index — the same crawl a run discovers through (ADR-0001 dec. 3). */
  registry: CapabilityRegistry;
  fetch?: HttpFetch | undefined;
  /** Fixture path → document, for the peers being watched that have no registration yet. */
  standins?: Record<string, Json> | undefined;
  /** Narrow the watch to these worlds. Defaults to whatever each peer declares. */
  worlds?: readonly string[] | undefined;
  /** Injectable clock, so a rendered feed is reproducible in a test. */
  now?: (() => string) | undefined;
  /** Problems carried in from discovery, so one panel shows every reason a peer is missing. */
  problems?: readonly string[] | undefined;
}

/** What one pass over every source delivered. */
export interface Sweep {
  sources: MonitorSource[];
  /** Frames read this sweep, across all sources. */
  frames: number;
  /** New events this sweep produced. */
  events: FabricEvent[];
  problems: string[];
}

/**
 * How the monitor describes itself — the passivity invariant, in a form a test can assert.
 *
 * `verbs` is checked against the class's own method names, so a future `invoke` or `relay`
 * fails the gate rather than quietly turning the observer into a participant.
 */
export interface MonitorDescription {
  identity: string;
  verbs: readonly string[];
  /** It is never in the path between two peers. */
  proxiesTraffic: false;
  /** It never causes fabric work; it registers as a consumer and reads. */
  originatesTraffic: false;
  /** How much of the control plane is visible under today's contracts. */
  controlPlane: 'emitted-telemetry-only';
  limitation: string;
}

export function describeMonitor(): MonitorDescription {
  return {
    identity: MONITOR_IDENTITY,
    verbs: ['subscribe'],
    proxiesTraffic: false,
    originatesTraffic: false,
    controlPlane: 'emitted-telemetry-only',
    limitation:
      'invocations between two other peers are visible only when the serving provider emits ' +
      'exchange telemetry on its own stream; a provider that emits none is absent at the ' +
      'invoke level. Tapping the wire between two peers would make this console a proxy ' +
      '(ADR-0001 decision 7). Full control-plane visibility needs the koine emitted-telemetry ' +
      'contract (a KCB observability extension).',
  };
}

export class FabricMonitor {
  /** The one log every sweep records into — the feed is a projection of it, nothing else. */
  readonly log: ObservationLog;
  private readonly problems: string[];
  private readonly watched = new Map<string, Watch>();

  constructor(private readonly options: MonitorOptions) {
    this.log = new ObservationLog(options.now ?? (() => new Date().toISOString()));
    this.problems = [...(options.problems ?? [])];
    this.index();
  }

  /** Every stream this monitor is registered on, live peers before stand-ins. */
  sources(): MonitorSource[] {
    return [...this.watched.values()].map((watch) => ({ ...watch.source }));
  }

  /** Why a peer is not being watched, when one is not — surfaced, never swallowed. */
  unwatched(): string[] {
    return [...this.problems];
  }

  /**
   * Register on every source and record what streams back.
   *
   * One sweep is one pass over the sources: a producer serving NDJSON delivers everything it
   * has queued for this consumer, a producer serving a snapshot delivers that. Sweeping again
   * appends to the same log, so the feed accumulates rather than resetting — which is what
   * makes "since" a useful filter rather than a description of the last button press.
   */
  async sweep(): Promise<Sweep> {
    const before = this.log.entries().length;
    const problems: string[] = [];
    for (const watch of this.watched.values()) {
      const targets = watch.source.worlds.length === 0 ? [undefined] : watch.source.worlds;
      for (const world of targets) {
        try {
          const summary = await watch.peer.subscribe({ step: MONITOR_STEP, world });
          watch.source.worlds = [...new Set([...watch.source.worlds, ...summary.worlds])];
        } catch (error) {
          problems.push(
            `${watch.source.identity}${world === undefined ? '' : ` (${world})`}: ${message(error)}`,
          );
        }
      }
    }
    const events = eventsFrom(this.log.entries().slice(before));
    for (const event of events) {
      if (event.kind !== 'span') continue;
      const watch = this.watched.get(event.participant);
      if (watch !== undefined) watch.source.emitsTelemetry = true;
    }
    for (const problem of problems) if (!this.problems.includes(problem)) this.problems.push(problem);
    return {
      sources: this.sources(),
      frames: this.log.entries().length - before,
      events,
      problems,
    };
  }

  /** Everything observed so far, oldest first. */
  events(): FabricEvent[] {
    return eventsFrom(this.log.entries());
  }

  /**
   * Which peers can be watched at all.
   *
   * A registration is watchable when it publishes a `subscribe` address — KCB §4 fixes the
   * verb, and an address is the promise that it is served (US-AG3). A peer that publishes
   * none is recorded as unwatchable rather than dialed on a guessed URL: inventing an address
   * is the one thing a lookup topology must never do.
   *
   * Stand-ins are watched too, and stamped. Four of the five platforms have not adopted the
   * bus, so a monitor that only watched registrations would show an empty feed and say nothing
   * about the fabric — while a fixture's frames are read through the same extraction a live
   * stream's are, and every observation they produce carries `standin: true`.
   */
  private index(): void {
    const fetch = this.options.fetch ?? platformFetch();
    for (const registration of this.options.registry.list()) {
      const endpoint = subscribeAddress(registration.manifest);
      if (endpoint === undefined) {
        this.problems.push(
          `${registration.identity} publishes no subscribe address — nothing to observe on it`,
        );
        continue;
      }
      this.watched.set(registration.identity, {
        peer: openLink(registration, { fetch, log: this.log }),
        source: {
          identity: registration.identity,
          worlds: this.worldsFor(worldsIn(registration)),
          endpoint,
          emitsTelemetry: false,
        },
      });
    }
    for (const [path, document] of Object.entries(this.options.standins ?? {})) {
      const fixture = readFixture(document, path);
      if (fixture === undefined || fixture.subscribe === undefined) continue;
      const identity = fixture.identity;
      if (identity === undefined || this.watched.has(identity)) continue;
      this.watched.set(identity, {
        peer: new Standin({ identity, fixtures: path, document: fixture, log: this.log }),
        source: {
          identity,
          worlds: this.worldsFor(Object.keys(fixture.subscribe)),
          standin: path,
          emitsTelemetry: false,
        },
      });
    }
  }

  /** The declared worlds, narrowed by the watch this monitor was configured with. */
  private worldsFor(declared: readonly string[]): string[] {
    const wanted = this.options.worlds;
    if (wanted === undefined) return [...declared];
    return declared.filter((world) => wanted.includes(world));
  }
}

interface Watch {
  peer: Peer;
  source: MonitorSource;
}

/** Where a provider serves `subscribe`, or `undefined` — never a guessed address. */
export function subscribeAddress(manifest: CapabilityManifest): string | undefined {
  for (const name of VERB_ENDPOINTS.subscribe) {
    const endpoint = manifest.endpoints[name];
    if (typeof endpoint === 'string' && endpoint !== '') return endpoint;
  }
  return undefined;
}

/**
 * The worlds a registration says it holds, read off its knowledge ports.
 *
 * Only concrete `worlds` count. A media port's `world_pattern` (KCB delta J) is a pattern —
 * `worldsim:world:*` names no world a consumer can register for, and expanding it into one
 * would subscribe to a world that may not exist. A peer that declares none is subscribed to
 * without a world filter, which is KCB §4's other form of the same verb.
 */
export function worldsIn(registration: Registration): string[] {
  const worlds = new Set<string>();
  for (const capability of registration.manifest.capabilities ?? []) {
    for (const port of [...(capability.inputs ?? []), ...(capability.outputs ?? [])]) {
      if (port.plane !== 'knowledge') continue;
      for (const world of port.worlds ?? []) worlds.add(world);
    }
  }
  return [...worlds];
}

/** A fixture the monitor was pointed at, or nothing — an unreadable one is not watchable. */
function readFixture(document: Json, path: string): StandinFixture | undefined {
  try {
    return parseFixture(document, path);
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
