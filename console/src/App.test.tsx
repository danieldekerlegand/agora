import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRegistry } from '@agora/registry';
import type { ScenarioDocument } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { runConformance, type ConformanceRun, type Discovery } from './commons.ts';
import { CAPTURED_FROM, replaySession } from './fixtures/session.ts';
import { bundledFixtures, monitorStandins, MEDIA_TRANSFORM_FORMANT } from './fixtures/standins.ts';
import { FabricMonitor } from './monitor/monitor.ts';
import { SCENARIO_LIBRARY } from './scenarios/library.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from './scenarios/provider-router-roundtrip.ts';
import { WORLDS_TO_FABRIC } from './scenarios/worlds-to-fabric.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

/** The live wiring, with the captured session in place of a socket. */
const replay = (scenario: ScenarioDocument): Promise<ConformanceRun> =>
  runConformance(scenario, {
    fetch: replaySession(),
    fixtures: bundledFixtures(),
    routerBaseUrl: CAPTURED_FROM,
    now: () => '2026-07-22T00:00:00.000Z',
  });

/** The library button that runs one scenario — what "on demand" means in the UI. */
function runButtonFor(id: string): HTMLElement {
  const entry = screen.getByText(id).closest('li');
  if (entry === null) throw new Error(`no library entry for ${id}`);
  return within(entry).getByRole('button');
}

/**
 * The report, as a scope. Every scenario's title is on screen twice once the library is
 * listed — once as a menu item, once over the report — so an assertion about *what ran*
 * has to say which one it means.
 */
function reportSection(): HTMLElement {
  return screen.getByRole('region', { name: 'conformance report' });
}

describe('console shell', () => {
  it('mounts and names itself', async () => {
    render(<App run={replay} />);
    expect(screen.getByRole('heading', { name: /conformance console/i })).toBeTruthy();
    await screen.findByTestId('verdict');
  });

  it('surfaces the identities it discovered from the other areas', async () => {
    render(<App run={replay} />);
    expect(screen.getByText('agora:agent:registry')).toBeTruthy();
    expect(screen.getByText('agora:agent:resolver')).toBeTruthy();
    await screen.findByTestId('verdict');
  });
});

describe('the scenario library', () => {
  it('lists every scenario the console ships, with what each one proves', async () => {
    render(<App run={replay} />);
    const library = screen.getByRole('navigation', { name: 'scenario library' });
    for (const entry of SCENARIO_LIBRARY) {
      expect(within(library).getByText(entry.scenario.id)).toBeTruthy();
      expect(within(library).getByText(entry.summary, { exact: false })).toBeTruthy();
    }
    await screen.findByTestId('verdict');
  });

  it('runs a different scenario on demand and reports on that one', async () => {
    // The acceptance criterion in one test: pick a scenario out of the library, it runs
    // over the same plumbing, and its report replaces the last one.
    render(<App run={replay} />);
    await screen.findByTestId('verdict');
    fireEvent.click(runButtonFor(WORLDS_TO_FABRIC.id));

    const scenario = await screen.findByTestId('report-scenario');
    expect(scenario.textContent).toContain(WORLDS_TO_FABRIC.id);
    // Three projects, none of them on the bus — the report has to say so out loud.
    expect(scenario.textContent).toContain('stood in for');
    const report = reportSection();
    expect(within(report).getByRole('heading', { level: 2 }).textContent).toContain(
      WORLDS_TO_FABRIC.title,
    );
    expect(within(report).getByTestId('verdict').textContent).toBe('green');
  });

  it('re-runs the selected scenario when asked again', async () => {
    render(<App run={replay} />);
    const first = (await screen.findByTestId('report-id')).textContent;
    fireEvent.click(runButtonFor(PROVIDER_ROUTER_ROUNDTRIP.id));
    // Same scenario, same fabric: a second run is the same evidence and so the same
    // address (KCS §4.4). That it re-ran at all is what the button is for.
    expect((await screen.findByTestId('report-id')).textContent).toBe(first);
  });
});

/**
 * Discovery with nothing registered, so the explorer offers only the peers that have not
 * adopted the bus (delta N) — which is what makes the manual test below a test against a
 * stand-in rather than against the one provider that happens to be on the network.
 */
const noRegistrations = (): Promise<Discovery> =>
  Promise.resolve({ registry: createRegistry(), providers: [], problems: [] });

/** Open the explorer on the stand-in composer and return its only capability's form. */
function chooseFormant(): void {
  fireEvent.change(screen.getByRole('combobox', { name: /provider/ }), {
    target: { value: 'composer:agent:composer' },
  });
}

describe('the capability explorer (manual mode)', () => {
  it('dials nobody until a request is composed and sent', async () => {
    render(<App mode="manual" run={replay} discover={noRegistrations} />);
    await screen.findByRole('combobox', { name: /provider/ });
    expect(screen.queryByTestId('verdict')).toBeNull();
  });

  it('browses the plane-typed ports a provider advertises, priced and addressed', async () => {
    render(<App mode="manual" run={replay} discover={noRegistrations} />);
    await screen.findByRole('combobox', { name: /provider/ });
    chooseFormant();
    // Everything the composer shows comes off the manifest, including what the provider
    // will demand of a caller before it grants anything (KCB §2 `auth`).
    expect(screen.getByTestId('grants-required').textContent).toBe('none stated');
    expect(screen.getByTestId('capability-endpoint').textContent).toBe('no address published');
    // The manifest's own numbers, not the console's opinion of them (KCB §2.1 delta K).
    expect(screen.getByTestId('capability-cost').textContent).toContain('24 budget units');
    expect(screen.getByTestId('capability-cost').textContent).toContain('tier paid-model');
    // A field per input port, labelled with the port's declared type — no hand-written form.
    expect(
      screen.getByRole('textbox', { name: /input 1 · knowledge · shape mood-descriptor/ }),
    ).toBeTruthy();
  });

  it('sends one manual invoke against a stand-in provider and reports it like any run', async () => {
    // The acceptance criterion end to end: no scenario file, the same discovery → direct
    // link → observation log → report plumbing, and the exchange on screen.
    render(<App mode="manual" run={replay} discover={noRegistrations} />);
    await screen.findByRole('combobox', { name: /provider/ });
    chooseFormant();
    fireEvent.change(screen.getByRole('textbox', { name: /input 1 · knowledge/ }), {
      target: { value: '{"mood":"elegiac"}' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'ceiling · budget units' }), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect((await screen.findByTestId('report-scenario')).textContent).toContain('kcs:manual');
    const report = reportSection();
    // Routing, cost and grant come back through the same views a scenario's do.
    expect((await screen.findByTestId('tier-manual')).textContent).toBe('paid-model');
    expect(screen.getByTestId('cost-manual').textContent).toBe('24 budget_units');
    expect(screen.getByTestId('manual-grant').textContent).toContain('granted');
    expect(screen.getByTestId('manual-request').textContent).toContain('"capability": "compose"');
    expect(screen.getByTestId('manual-response').textContent).toContain(
      'composer:asset:blake3-5c0e33',
    );
    // Stood in for, and the report says so — a manual green is not a claim about a live peer.
    expect(within(report).getByTestId('report-scenario').textContent).toContain('stood in for');
    expect(within(report).getAllByText(MEDIA_TRANSFORM_FORMANT, { exact: false })).not.toHaveLength(
      0,
    );
    expect(within(report).getAllByTestId(/^observation-/).length).toBeGreaterThan(1);
  });

  it('refuses to send a port payload that is not JSON, before anybody is dialed', async () => {
    render(<App mode="manual" run={replay} discover={noRegistrations} />);
    await screen.findByRole('combobox', { name: /provider/ });
    chooseFormant();
    fireEvent.change(screen.getByRole('textbox', { name: /input 1 · knowledge/ }), {
      target: { value: '{oops' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(screen.getByRole('alert').textContent).toMatch(/is not JSON/);
    expect(screen.queryByTestId('verdict')).toBeNull();
  });
});

/**
 * The monitor over the peers it is pointed at, with nothing registered — so every event on
 * screen is one another platform published, and none of it was caused by this console.
 */
const watchStandins = (): Promise<FabricMonitor> =>
  Promise.resolve(
    new FabricMonitor({
      registry: createRegistry(),
      fetch: replaySession(),
      standins: monitorStandins(),
      now: () => '2026-07-22T11:05:00.000Z',
    }),
  );

describe('the live fabric monitor (passive mode)', () => {
  it('shows events crossing the fabric that the console did not initiate', async () => {
    render(<App mode="monitor" run={replay} observe={watchStandins} />);
    const feed = await screen.findByRole('table', { name: 'fabric events' });
    // A KGP delta and a media event, from two platforms, neither of them asked for here.
    expect(within(feed).getAllByText('claim').length).toBeGreaterThan(0);
    expect(within(feed).getAllByText('asset').length).toBeGreaterThan(0);
    expect(within(feed).getAllByText(/insimul:world:alderforest:ent:npc-renaud/).length,
    ).toBeGreaterThan(0);
    // Nothing was run, so there is no report — a watch produces observations, not verdicts.
    expect(screen.queryByTestId('verdict')).toBeNull();
  });

  it('renders an exchange between two other peers, from the telemetry its server emitted', async () => {
    render(<App mode="monitor" run={replay} observe={watchStandins} />);
    const feed = await screen.findByRole('table', { name: 'fabric events' });
    expect(within(feed).getByText(/composer:agent:composer → analyzer:agent:ingest/)).toBeTruthy();
    expect(within(feed).getAllByText('control').length).toBe(1);
  });

  it('says out loud how much of the control plane it can see', async () => {
    render(<App mode="monitor" run={replay} observe={watchStandins} />);
    const limitation = await screen.findByTestId('monitor-limitation');
    expect(limitation.textContent).toMatch(/absent at the invoke level/);
    // Which peers are invisible at the invoke level is on screen per source, not just in prose.
    expect(
      screen.getByTestId('source-insimul:agent:world-server').textContent,
    ).toContain('no exchange telemetry');
    expect(screen.getByTestId('source-analyzer:agent:ingest').textContent).toContain(
      'emits exchange telemetry',
    );
  });

  it('filters the feed by plane, world and participant', async () => {
    render(<App mode="monitor" run={replay} observe={watchStandins} />);
    const total = (await screen.findByTestId('feed-count')).textContent;
    expect(total).toMatch(/^4 of 4 events$/);

    fireEvent.change(screen.getByRole('combobox', { name: /plane/ }), {
      target: { value: 'media' },
    });
    expect(screen.getByTestId('feed-count').textContent).toBe('1 of 4 events');

    fireEvent.change(screen.getByRole('combobox', { name: /plane/ }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: /participant/ }), {
      target: { value: 'insimul:agent:world-server' },
    });
    expect(screen.getByTestId('feed-count').textContent).toBe('1 of 4 events');

    // A time the whole sweep predates: the feed narrows to nothing rather than ignoring it.
    fireEvent.change(screen.getByRole('combobox', { name: /participant/ }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'since' }), {
      target: { value: '2026-07-23T00:00:00.000Z' },
    });
    expect(screen.getByTestId('feed-count').textContent).toBe('0 of 4 events');
  });

  it('accumulates across sweeps rather than replacing what is on screen', async () => {
    render(<App mode="monitor" run={replay} observe={watchStandins} />);
    await screen.findByRole('table', { name: 'fabric events' });
    fireEvent.click(screen.getByRole('button', { name: 'sweep again' }));
    expect((await screen.findByTestId('feed-count')).textContent).toBe('8 of 8 events');
  });
});

describe('the shipped scenario, rendered', () => {
  it('runs it on mount and reports green', async () => {
    render(<App run={replay} />);
    expect((await screen.findByTestId('verdict')).textContent).toBe('green');
    expect(
      within(reportSection()).getByText(PROVIDER_ROUTER_ROUNDTRIP.title, { exact: false }),
    ).toBeTruthy();
  });

  it('shows the content address the report was archived under', async () => {
    render(<App run={replay} />);
    expect((await screen.findByTestId('report-id')).textContent).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('shows which tier served the completion and what it cost', async () => {
    // The acceptance criterion in one assertion: a round-trip resolved via the zero-spend
    // tier, with the resolved tier and the cost surfaced in the console.
    render(<App run={replay} />);
    expect((await screen.findByTestId('tier-completion')).textContent).toBe('placeholder');
    expect((await screen.findByTestId('cost-completion')).textContent).toBe('0 budget_units');
  });

  it('shows every assertion with its verdict and the log slice under it', async () => {
    render(<App run={replay} />);
    await screen.findByTestId('verdict');
    for (const predicate of ['tier_resolved', 'cost_within_ceiling', 'always_completes']) {
      expect(screen.getByText(predicate)).toBeTruthy();
    }
    expect(screen.queryByText('fail')).toBeNull();
    // A verdict nobody can audit is an opinion: each one names the entries that convinced it.
    expect(screen.getByTestId('support-served-by-the-zero-spend-tier').textContent).toMatch(
      /supported by #\d+/,
    );
  });

  it('renders the observation timeline, stamped and with the ids each entry touched', async () => {
    render(<App run={replay} />);
    await screen.findByTestId('verdict');
    const timeline = screen.getByRole('table', { name: 'observation timeline' });
    const first = within(timeline).getByTestId('observation-1');
    expect(first.textContent).toContain('2026-07-22T00:00:00.000Z');
    expect(first.textContent).toContain('discovery');
    expect(within(timeline).getAllByTestId(/^observation-/).length).toBeGreaterThan(1);
  });

  it('names the address it dialed directly', async () => {
    render(<App run={replay} />);
    await screen.findByTestId('verdict');
    expect(screen.getByText(/dialed directly over the openai wire/)).toBeTruthy();
  });

  it('renders a red report — with the reason — when the provider is not there', async () => {
    const missing = (scenario: ScenarioDocument): Promise<ConformanceRun> =>
      runConformance(scenario, {
        fetch: () =>
          Promise.resolve({
            ok: false,
            status: 502,
            headers: { get: () => null },
            json: () => Promise.resolve({}),
          }),
        routerBaseUrl: CAPTURED_FROM,
      });
    render(<App run={missing} />);
    expect((await screen.findByTestId('verdict')).textContent).toBe('red');
    expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/provider-router at/);
  });
});
