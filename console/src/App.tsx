/**
 * The conformance console.
 *
 * It runs a KCS scenario against the live commons and renders what was observed: which
 * providers were discovered, which tier served each routed call and what it cost, every
 * assertion's verdict, and the observation log underneath.
 *
 * ADR-0001 decision 7 is the shape of this component: the console *runs* a scenario, it
 * does not sit between anybody. `run` is a prop so a test can replay a captured session
 * instead of opening a socket — the seam is the transport, never the logic under test.
 */
import { useEffect, useState } from 'react';

import { describeRegistry } from '@agora/registry';
import { describeResolver } from '@agora/resolver';
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

import './App.css';
import { runConformance, type ConformanceRun } from './commons.ts';
import { routings } from './kcs/outcome.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from './scenarios/provider-router-roundtrip.ts';

export interface AppProps {
  scenario?: ScenarioDocument;
  /** How to run it. Defaults to the live commons — discover, then dial directly. */
  run?: (scenario: ScenarioDocument) => Promise<ConformanceRun>;
}

type State =
  | { phase: 'running' }
  | { phase: 'done'; run: ConformanceRun }
  | { phase: 'error'; error: string };

export function App({
  scenario = PROVIDER_ROUTER_ROUNDTRIP,
  run = (document) => runConformance(document),
}: AppProps) {
  const [state, setState] = useState<State>({ phase: 'running' });

  useEffect(() => {
    let live = true;
    run(scenario)
      .then((result) => {
        if (live) setState({ phase: 'done', run: result });
      })
      .catch((error: unknown) => {
        if (live) {
          setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      live = false;
    };
  }, [scenario, run]);

  return (
    <main className="console">
      <header>
        <h1>agora — conformance console</h1>
        <p>
          An observer on real connections, not a hub. Scenarios discover providers through the
          registry and open direct links to them; nothing is relayed through here.
        </p>
        <dl className="versions">
          <dt>KCS</dt>
          <dd>{SPEC_VERSIONS.kcs}</dd>
          <dt>KCB</dt>
          <dd>{SPEC_VERSIONS.kcb}</dd>
          <dt>KINP</dt>
          <dd>{SPEC_VERSIONS.kinp}</dd>
          <dt>registry</dt>
          <dd>{describeRegistry().identity}</dd>
          <dt>resolver</dt>
          <dd>{describeResolver().identity}</dd>
        </dl>
      </header>

      {state.phase === 'running' && <p role="status">running {scenario.id}…</p>}
      {state.phase === 'error' && <p role="alert">the scenario could not be run: {state.error}</p>}
      {state.phase === 'done' && <Report run={state.run} />}
    </main>
  );
}

function Report({ run }: { run: ConformanceRun }) {
  const { report, discovery } = run;
  const routed = routings(report);
  return (
    <section aria-label="conformance report">
      <h2>
        {report.title}{' '}
        <span className={report.green ? 'verdict green' : 'verdict red'} data-testid="verdict">
          {report.green ? 'green' : 'red'}
        </span>
      </h2>
      <p className="scenario-id">
        {report.scenario} · KCS {report.kcsVersion} · {report.observations.length} observations
        {report.stubbed ? ' · some participants were stood in for' : ''}
      </p>

      {discovery.problems.map((problem) => (
        <p role="alert" key={problem}>
          {problem}
        </p>
      ))}

      <h3>Routing</h3>
      {routed.length === 0 ? (
        <p>no capability was routed</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">step</th>
              <th scope="col">tier</th>
              <th scope="col">model</th>
              <th scope="col">ceiling</th>
              <th scope="col">spent</th>
            </tr>
          </thead>
          <tbody>
            {routed.map((routing) => (
              <tr key={routing.step}>
                <td>{routing.step}</td>
                <td data-testid={`tier-${routing.step}`}>{routing.tier}</td>
                <td>{routing.model ?? '—'}</td>
                <td>{routing.budgetUnits === null ? 'none' : `${routing.budgetUnits}`}</td>
                <td data-testid={`cost-${routing.step}`}>
                  {routing.actualUnits} {routing.currency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Participants</h3>
      <ul>
        {report.participants.map((participant) => (
          <li key={participant.identity}>
            <code>{participant.identity}</code> — {participant.endpoint ?? 'no address'} (
            {participant.note})
          </li>
        ))}
      </ul>

      <h3>Assertions</h3>
      <ul>
        {report.assertions.map((assertion) => (
          <li key={assertion.id} className={assertion.ok ? 'pass' : 'fail'}>
            <strong>{assertion.ok ? 'pass' : assertion.pending ? 'pending' : 'fail'}</strong>{' '}
            <code>{assertion.predicate}</code> — {assertion.detail}
          </li>
        ))}
      </ul>

      <h3>Steps</h3>
      <ol>
        {report.steps.map((step) => (
          <li key={step.id} className={step.status}>
            <code>{step.id}</code> ({step.kind}) — {step.status}
            {step.error === undefined ? '' : `: ${step.error}`}
            {step.title === undefined ? '' : ` — ${step.title}`}
          </li>
        ))}
      </ol>

      <h3>Observation log</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">step</th>
            <th scope="col">participant</th>
            <th scope="col">direction</th>
            <th scope="col">detail</th>
          </tr>
        </thead>
        <tbody>
          {report.observations.map((observation) => (
            <tr key={observation.seq}>
              <td>{observation.seq}</td>
              <td>{observation.step}</td>
              <td>{observation.participant}</td>
              <td>{observation.direction}</td>
              <td>
                <code>{JSON.stringify(observation.detail)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
