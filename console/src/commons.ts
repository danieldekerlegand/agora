/**
 * Bootstrapping the commons for a run: build an index, crawl the providers, run a
 * scenario against what was found.
 *
 * The console holds its own registry instance rather than calling a registry *service*,
 * and that is not a shortcut — the registry is a lookup index (ADR-0001 decision 3), so a
 * peer keeping a local one and crawling manifests directly is the topology, not a
 * simulation of it. The addresses it yields are the providers' own.
 *
 * A provider that cannot be crawled is **not** an exception here: it becomes an
 * undiscovered participant, the steps that needed it fail, and the report says the router
 * was not reachable. A console that threw on a missing provider would show a blank screen
 * for the one failure it exists to make visible.
 */
import {
  createRegistry,
  PROVIDER_ROUTER_BASE_URL,
  registerProviderRouter,
  type CapabilityRegistry,
} from '@agora/registry';
import type { ScenarioDocument } from '@agora/schemas';

import { archiveReport, type ReportArchive } from './kcs/archive.ts';
import { platformFetch, type HttpFetch } from './kcs/http.ts';
import type { ConformanceReport } from './kcs/outcome.ts';
import { runScenario, type RunOptions } from './kcs/runner.ts';
import { FabricMonitor, type MonitorOptions } from './monitor/monitor.ts';

export interface DiscoveryOptions {
  fetch?: HttpFetch | undefined;
  /** Where the provider-router lives. Defaults to its own advertised bind address. */
  routerBaseUrl?: string | undefined;
}

export interface Discovery {
  registry: CapabilityRegistry;
  /** Identities indexed, in registration order. */
  providers: string[];
  /** Why a provider is missing, when one is — surfaced, never swallowed. */
  problems: string[];
}

/** Index every provider the commons knows how to find. Today: the provider-router. */
export async function discoverCommons(options: DiscoveryOptions = {}): Promise<Discovery> {
  const registry = createRegistry();
  const problems: string[] = [];
  const fetch = options.fetch ?? platformFetch();
  const baseUrl = options.routerBaseUrl ?? PROVIDER_ROUTER_BASE_URL;
  try {
    await registerProviderRouter(registry, baseUrl, { fetch });
  } catch (error) {
    problems.push(
      `provider-router at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { registry, providers: registry.list().map((entry) => entry.identity), problems };
}

export interface ConformanceRunOptions extends DiscoveryOptions {
  now?: RunOptions['now'];
  clock?: RunOptions['clock'];
  resolver?: RunOptions['resolver'];
  /** How a `standin` participant's fixtures are loaded (KCS delta N). */
  fixtures?: RunOptions['fixtures'];
}

export interface ConformanceRun {
  discovery: Discovery;
  report: ConformanceReport;
  /** The report, addressed by its content (KCS §4.4) — archived as soon as it exists. */
  archive: ReportArchive;
}

/**
 * Discover, then run one scenario against what was discovered, then address the report.
 *
 * Addressing happens here rather than in the runner because the address is over a *finished*
 * report: a run cannot contain its own content address, and a caller who had to remember to
 * take one would eventually ship a report nobody can cite.
 */
export async function runConformance(
  scenario: ScenarioDocument,
  options: ConformanceRunOptions = {},
): Promise<ConformanceRun> {
  const fetch = options.fetch ?? platformFetch();
  const discovery = await discoverCommons({ ...options, fetch });
  const report = await runScenario(scenario, {
    registry: discovery.registry,
    fetch,
    now: options.now,
    clock: options.clock,
    resolver: options.resolver,
    fixtures: options.fixtures,
  });
  return { discovery, report, archive: await archiveReport(report, { now: options.now }) };
}

export interface ObserveOptions extends DiscoveryOptions {
  /** The peers to watch that have not adopted the bus yet (KCS delta N). */
  standins?: MonitorOptions['standins'];
  worlds?: MonitorOptions['worlds'];
  now?: MonitorOptions['now'];
}

/**
 * Discover the commons, then open a **passive** watch over it (US-CS7).
 *
 * The same crawl a run discovers through, handed to a monitor instead of to a runner: the
 * monitor registers as a consumer on the streams those providers publish and reads what
 * crosses them, whoever caused it. Discovery's problems ride along, so one panel can show
 * both "this provider could not be crawled" and "this provider publishes nothing to watch".
 */
export function observeCommons(options: ObserveOptions = {}): Promise<FabricMonitor> {
  const fetch = options.fetch ?? platformFetch();
  return discoverCommons({ ...options, fetch }).then(
    (discovery) =>
      new FabricMonitor({
        registry: discovery.registry,
        fetch,
        standins: options.standins,
        worlds: options.worlds,
        now: options.now,
        problems: discovery.problems,
      }),
  );
}
