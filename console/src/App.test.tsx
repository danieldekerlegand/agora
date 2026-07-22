import { render, screen } from '@testing-library/react';
import type { ScenarioDocument } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { runConformance, type ConformanceRun } from './commons.ts';
import { CAPTURED_FROM, replaySession } from './fixtures/session.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from './scenarios/provider-router-roundtrip.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

/** The live wiring, with the captured session in place of a socket. */
const replay = (scenario: ScenarioDocument): Promise<ConformanceRun> =>
  runConformance(scenario, {
    fetch: replaySession(),
    routerBaseUrl: CAPTURED_FROM,
    now: () => '2026-07-22T00:00:00.000Z',
  });

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

describe('the shipped scenario, rendered', () => {
  it('runs it on mount and reports green', async () => {
    render(<App run={replay} />);
    expect((await screen.findByTestId('verdict')).textContent).toBe('green');
    expect(screen.getByText(PROVIDER_ROUTER_ROUNDTRIP.title, { exact: false })).toBeTruthy();
  });

  it('shows which tier served the completion and what it cost', async () => {
    // The acceptance criterion in one assertion: a round-trip resolved via the zero-spend
    // tier, with the resolved tier and the cost surfaced in the console.
    render(<App run={replay} />);
    expect((await screen.findByTestId('tier-completion')).textContent).toBe('placeholder');
    expect((await screen.findByTestId('cost-completion')).textContent).toBe('0 budget_units');
  });

  it('shows every assertion with its verdict', async () => {
    render(<App run={replay} />);
    await screen.findByTestId('verdict');
    for (const predicate of ['tier_resolved', 'cost_within_ceiling', 'always_completes']) {
      expect(screen.getByText(predicate)).toBeTruthy();
    }
    expect(screen.queryByText('fail')).toBeNull();
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
