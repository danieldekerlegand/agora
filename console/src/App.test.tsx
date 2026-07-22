import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ScenarioDocument } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { runConformance, type ConformanceRun } from './commons.ts';
import { CAPTURED_FROM, replaySession } from './fixtures/session.ts';
import { bundledFixtures } from './fixtures/standins.ts';
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
