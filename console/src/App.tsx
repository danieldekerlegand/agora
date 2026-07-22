/**
 * The conformance console.
 *
 * It lists the scenario library, runs any of them on demand against the live commons, and
 * renders what was observed: the report's content address, which providers were discovered,
 * which tier served each routed call and what it cost, every assertion's verdict with the
 * log slice supporting it, and the observation timeline underneath.
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
import { bundledFixtures } from './fixtures/standins.ts';
import { routings, type AssertionOutcome } from './kcs/outcome.ts';
import { SCENARIO_LIBRARY, type LibraryEntry } from './scenarios/library.ts';

export interface AppProps {
  /** What the console offers. Defaults to every scenario it ships. */
  library?: readonly LibraryEntry[];
  /** Which one is selected on mount. Defaults to the first in the library. */
  scenario?: ScenarioDocument;
  /** How to run it. Defaults to the live commons — discover, then dial directly. */
  run?: (scenario: ScenarioDocument) => Promise<ConformanceRun>;
}

type State =
  | { phase: 'running' }
  | { phase: 'done'; run: ConformanceRun }
  | { phase: 'error'; error: string };

/**
 * The live wiring. The stand-in fixtures a library scenario names (KCS delta N) are the
 * ones this console ships, so the library runs the same way in a browser as in the gate —
 * a stand-in is only ever consulted for a participant the registry could not resolve.
 */
const liveRun = (document: ScenarioDocument): Promise<ConformanceRun> =>
  runConformance(document, { fixtures: bundledFixtures() });

export function App({ library = SCENARIO_LIBRARY, scenario, run = liveRun }: AppProps) {
  const [selected, setSelected] = useState(scenario ?? library[0]?.scenario);
  // Bumped by "run again": the same scenario twice is two runs, and a conformance report is
  // about one of them. Without it React would see identical deps and skip the second.
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ phase: 'running' });

  useEffect(() => {
    let live = true;
    if (selected === undefined) {
      setState({ phase: 'error', error: 'the scenario library is empty' });
      return;
    }
    setState({ phase: 'running' });
    run(selected)
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
  }, [selected, attempt, run]);

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

      <Library
        library={library}
        selected={selected?.id}
        busy={state.phase === 'running'}
        onRun={(entry) => {
          if (entry.scenario.id === selected?.id) setAttempt((count) => count + 1);
          else setSelected(entry.scenario);
        }}
      />

      {state.phase === 'running' && <p role="status">running {selected?.id}…</p>}
      {state.phase === 'error' && <p role="alert">the scenario could not be run: {state.error}</p>}
      {state.phase === 'done' && <Report run={state.run} />}
    </main>
  );
}

function Library({
  library,
  selected,
  busy,
  onRun,
}: {
  library: readonly LibraryEntry[];
  selected: string | undefined;
  busy: boolean;
  onRun: (entry: LibraryEntry) => void;
}) {
  return (
    <nav aria-label="scenario library">
      <h2>Scenario library</h2>
      <ul className="library">
        {library.map((entry) => (
          <li
            key={entry.scenario.id}
            className={entry.scenario.id === selected ? 'entry selected' : 'entry'}
          >
            <button
              type="button"
              disabled={busy}
              aria-current={entry.scenario.id === selected}
              onClick={() => {
                onRun(entry);
              }}
            >
              {entry.scenario.id === selected ? 'run again' : 'run'}
            </button>{' '}
            <code>{entry.scenario.id}</code> — {entry.scenario.title}
            <p className="summary">
              {entry.summary}
              {entry.source === undefined ? '' : ` (${entry.source})`}
            </p>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Report({ run }: { run: ConformanceRun }) {
  const { report, discovery, archive } = run;
  const routed = routings(report);
  return (
    <section aria-label="conformance report">
      <h2>
        {report.title}{' '}
        <span className={report.green ? 'verdict green' : 'verdict red'} data-testid="verdict">
          {report.green ? 'green' : 'red'}
        </span>
      </h2>
      <p className="scenario-id" data-testid="report-scenario">
        {report.scenario} · KCS {report.kcsVersion} · {report.observations.length} observations
        {report.stubbed ? ' · some participants were stood in for' : ''}
      </p>
      {/* The archived report's content address (KCS §4.4): re-running this scenario against
          the same fabric mints the same id, so a changed id is itself a finding. */}
      <p className="report-id">
        archived as <code data-testid="report-id">{archive.report_id}</code>
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
      <ul aria-label="assertions">
        {report.assertions.map((assertion) => (
          <li key={assertion.id} className={assertion.ok ? 'pass' : 'fail'}>
            <strong>{assertion.ok ? 'pass' : assertion.pending ? 'pending' : 'fail'}</strong>{' '}
            <code>{assertion.predicate}</code> — {assertion.detail}
            <Support assertion={assertion} />
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

      <h3>Observation timeline</h3>
      <table aria-label="observation timeline">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">at</th>
            <th scope="col">step</th>
            <th scope="col">participant</th>
            <th scope="col">plane</th>
            <th scope="col">direction</th>
            <th scope="col">ids touched</th>
            <th scope="col">detail</th>
          </tr>
        </thead>
        <tbody>
          {report.observations.map((observation) => (
            <tr key={observation.seq} data-testid={`observation-${observation.seq}`}>
              <td>{observation.seq}</td>
              <td>{observation.at}</td>
              <td>{observation.step}</td>
              <td>{observation.participant}</td>
              <td>{observation.plane ?? '—'}</td>
              <td>{observation.direction}</td>
              <td>
                {observation.entities.map((id) => (
                  <code key={id}>{id} </code>
                ))}
              </td>
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

/**
 * The log slice a verdict rests on (KCS §4.4). Rendered as the entries' sequence numbers
 * rather than a second copy of them: they are all in the timeline below, and an assertion
 * pointing at *which* traffic convinced it is what makes a report auditable.
 */
function Support({ assertion }: { assertion: AssertionOutcome }) {
  if (assertion.support.length === 0) return null;
  return (
    <span className="support" data-testid={`support-${assertion.id}`}>
      {' '}
      — supported by {assertion.support.map((entry) => `#${entry.seq}`).join(', ')}
    </span>
  );
}
