/**
 * The conformance console.
 *
 * Two panels over one engine. The **scenario library** runs an authored KCS document on
 * demand; the **capability explorer** composes a single request by hand from what the
 * registry advertises. Both compile to a `ScenarioDocument` and go through the same
 * `runConformance` — discovery through the registry, a direct link to the provider, one
 * observation log, one report. A manual request that had its own client would be a second,
 * unwitnessed implementation of ADR-0001 decision 7.
 *
 * What a report renders is the same either way: the content address, which providers were
 * discovered, which tier served each routed call and what it cost, every assertion's verdict
 * with the log slice supporting it, and the observation timeline underneath.
 *
 * `run` and `discover` are props so a test can replay a captured session instead of opening
 * a socket — the seam is the transport, never the logic under test.
 */
import { useCallback, useEffect, useState } from 'react';

import { describeRegistry } from '@agora/registry';
import { describeResolver } from '@agora/resolver';
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

import './App.css';
import { discoverCommons, runConformance, type ConformanceRun, type Discovery } from './commons.ts';
import { bundledFixtures, bundledStandins } from './fixtures/standins.ts';
import { routings, type AssertionOutcome, type ConformanceReport } from './kcs/outcome.ts';
import { Explorer } from './manual/Explorer.tsx';
import { catalogue, type CataloguedProvider } from './manual/catalogue.ts';
import { manualScenario, MANUAL_STEP_ID, type ManualRequest } from './manual/request.ts';
import { SCENARIO_LIBRARY, type LibraryEntry } from './scenarios/library.ts';

/** Which panel is open. The library proves properties; the explorer asks questions. */
export type Mode = 'library' | 'manual';

export interface AppProps {
  /** What the console offers. Defaults to every scenario it ships. */
  library?: readonly LibraryEntry[];
  /** Which one is selected on mount. Defaults to the first in the library. */
  scenario?: ScenarioDocument;
  /** How to run it. Defaults to the live commons — discover, then dial directly. */
  run?: (scenario: ScenarioDocument) => Promise<ConformanceRun>;
  /** How the explorer finds what to offer. Defaults to the same crawl a run does. */
  discover?: () => Promise<Discovery>;
  /** Which panel is open on mount. Defaults to the library. */
  mode?: Mode;
}

type State =
  /** Manual mode on mount: nothing has been sent, and the console has dialed nobody. */
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; run: ConformanceRun; manual?: ManualRequest | undefined }
  | { phase: 'error'; error: string };

/**
 * The live wiring. The stand-in fixtures a library scenario names (KCS delta N) are the
 * ones this console ships, so the library runs the same way in a browser as in the gate —
 * a stand-in is only ever consulted for a participant the registry could not resolve.
 */
const liveRun = (document: ScenarioDocument): Promise<ConformanceRun> =>
  runConformance(document, { fixtures: bundledFixtures() });

const liveDiscovery = (): Promise<Discovery> => discoverCommons();

export function App({
  library = SCENARIO_LIBRARY,
  scenario,
  run = liveRun,
  discover = liveDiscovery,
  mode: initialMode = 'library',
}: AppProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState(scenario ?? library[0]?.scenario);
  // Bumped by "run again": the same scenario twice is two runs, and a conformance report is
  // about one of them. Without it React would see identical deps and skip the second.
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>(
    initialMode === 'library' ? { phase: 'running' } : { phase: 'idle' },
  );
  const [providers, setProviders] = useState<readonly CataloguedProvider[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);

  useEffect(() => {
    // Only the library auto-runs. Opening the explorer must not dial anybody: manual mode
    // exists so that what goes out is what an operator composed and nothing else.
    if (mode !== 'library') return;
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
  }, [selected, attempt, run, mode]);

  useEffect(() => {
    // The catalogue is discovery, not traffic: the explorer needs the index before an
    // operator can pick anything, and crawling manifests is what the registry is for.
    if (mode !== 'manual') return;
    let live = true;
    void discover().then((discovery) => {
      if (!live) return;
      setProviders(catalogue({ registry: discovery.registry, standins: bundledStandins() }));
      setProblems(discovery.problems);
    });
    return () => {
      live = false;
    };
  }, [discover, mode]);

  const send = useCallback(
    (request: ManualRequest): void => {
      setState({ phase: 'running' });
      run(manualScenario(request))
        .then((result) => {
          setState({ phase: 'done', run: result, manual: request });
        })
        .catch((error: unknown) => {
          setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        });
    },
    [run],
  );

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

      <nav aria-label="console mode" className="modes">
        {(['library', 'manual'] as const).map((panel) => (
          <button
            key={panel}
            type="button"
            aria-pressed={mode === panel}
            onClick={() => {
              setMode(panel);
            }}
          >
            {panel === 'library' ? 'scenario library' : 'capability explorer'}
          </button>
        ))}
      </nav>

      {mode === 'library' ? (
        <Library
          library={library}
          selected={selected?.id}
          busy={state.phase === 'running'}
          onRun={(entry) => {
            if (entry.scenario.id === selected?.id) setAttempt((count) => count + 1);
            else setSelected(entry.scenario);
          }}
        />
      ) : (
        <Explorer
          providers={providers}
          problems={problems}
          busy={state.phase === 'running'}
          onSend={send}
        />
      )}

      {state.phase === 'idle' && <p>nothing has been sent yet.</p>}
      {state.phase === 'running' && (
        <p role="status">running {mode === 'manual' ? 'the composed request' : selected?.id}…</p>
      )}
      {state.phase === 'error' && <p role="alert">the scenario could not be run: {state.error}</p>}
      {state.phase === 'done' && <Report run={state.run} manual={state.manual} />}
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

function Report({ run, manual }: { run: ConformanceRun; manual?: ManualRequest | undefined }) {
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

      {manual !== undefined && <Exchange report={report} manual={manual} />}

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
            {/* The provider's own refusal, kept apart from the error text: under
                `expect: reject` a refusal is how a step *passes* (KCS delta O). */}
            {step.refused === undefined ? null : (
              <span className="refused">
                {' '}
                — the provider refused with {step.refused.status}: {step.refused.reason}
              </span>
            )}
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
 * The one exchange a manual request produced, in full.
 *
 * A scenario report summarises — that is what makes it auditable at a glance. An operator
 * who composed a request by hand is asking a different question ("what exactly did it say?"),
 * so the composed request and the provider's verbatim answer are rendered here, above the
 * same observation timeline every run gets. `raw` is the provider's own body (`kcs/wire.ts`);
 * for `fetch` and `resolve` there is no invocation body and the bound result stands in.
 */
function Exchange({ report, manual }: { report: ConformanceReport; manual: ManualRequest }) {
  const step = report.steps.find((entry) => entry.id === MANUAL_STEP_ID);
  const answer = step?.result?.raw ?? step?.output ?? null;
  return (
    <section aria-label="manual exchange" className="exchange">
      <h3>Manual exchange</h3>
      <p data-testid="manual-grant">
        grant:{' '}
        {step?.refused === undefined
          ? 'granted — the provider served the call'
          : `refused with ${step.refused.status}: ${step.refused.reason}`}
      </p>
      <h4>Raw request</h4>
      <pre data-testid="manual-request">{JSON.stringify(manual, null, 2)}</pre>
      <h4>Raw response</h4>
      <pre data-testid="manual-response">{JSON.stringify(answer, null, 2)}</pre>
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
