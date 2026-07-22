/**
 * The live fabric monitor's panel.
 *
 * A feed of what crossed the fabric, filterable by world, plane, participant and time, with
 * every row naming the KINP ids it touched. It renders what {@link FabricMonitor} observed and
 * owns no transport of its own — the same arrangement the explorer has with the runner.
 *
 * Two things are stated on screen rather than only in the code, because both are properties of
 * the *topology* and a reader of a feed is entitled to know them: that nothing here is relayed
 * (the monitor subscribes, it does not sit between peers), and exactly how much of the control
 * plane is visible today. A monitor that quietly showed an empty invoke-level view would read
 * as "no invocations happened" when it means "nobody emitted telemetry".
 */
import { useMemo, useState } from 'react';

import { describeMonitor, type MonitorSource } from './monitor.ts';
import { feedFacets, filterFeed, type FabricEvent, type FeedPlane } from './feed.ts';

export interface MonitorProps {
  sources: readonly MonitorSource[];
  events: readonly FabricEvent[];
  /** Why a peer is not being watched, when one is not. */
  problems?: readonly string[];
  /** True while a sweep is in flight. */
  busy: boolean;
  onRefresh: () => void;
}

/** The filter's "no clause" option — `''` because that is what an empty `<select>` reads as. */
const ANY = '';

export function Monitor({ sources, events, problems = [], busy, onRefresh }: MonitorProps) {
  const [world, setWorld] = useState(ANY);
  const [plane, setPlane] = useState<FeedPlane | ''>(ANY);
  const [participant, setParticipant] = useState(ANY);
  const [since, setSince] = useState(ANY);
  const facets = useMemo(() => feedFacets(events), [events]);
  const shown = useMemo(
    () =>
      filterFeed(events, {
        ...(world === ANY ? {} : { world }),
        ...(plane === ANY ? {} : { plane }),
        ...(participant === ANY ? {} : { participant }),
        ...(since.trim() === ANY ? {} : { since: since.trim() }),
      }),
    [events, world, plane, participant, since],
  );
  const monitor = describeMonitor();

  return (
    <section aria-label="fabric monitor" className="monitor">
      <h2>Live fabric monitor</h2>
      <p className="summary">
        What crosses the fabric, whether or not this console asked for it. The monitor registers
        as a consumer on the streams providers publish (KCB §4 <code>subscribe</code>) and reads
        them; it is never in the path between two peers.
      </p>
      <p className="limitation" data-testid="monitor-limitation">
        Control plane: {monitor.limitation}
      </p>

      {problems.map((problem) => (
        <p role="alert" key={problem}>
          {problem}
        </p>
      ))}

      <h3>Watching</h3>
      <ul aria-label="monitored sources">
        {sources.length === 0 && <li>no peer publishes a stream to watch</li>}
        {sources.map((source) => (
          <li key={source.identity} data-testid={`source-${source.identity}`}>
            <code>{source.identity}</code> —{' '}
            {source.standin === undefined
              ? (source.endpoint ?? 'no address')
              : `${source.standin} (stand-in — not a live connection)`}
            {source.worlds.length === 0 ? ' · whole stream' : ` · ${source.worlds.join(', ')}`}
            {source.emitsTelemetry
              ? ' · emits exchange telemetry'
              : ' · no exchange telemetry — invisible at the invoke level'}
          </li>
        ))}
      </ul>

      <div className="filters">
        <label>
          world{' '}
          <select
            value={world}
            onChange={(event) => {
              setWorld(event.target.value);
            }}
          >
            <option value={ANY}>any</option>
            {facets.worlds.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          plane{' '}
          <select
            value={plane}
            onChange={(event) => {
              setPlane(event.target.value as FeedPlane | '');
            }}
          >
            <option value={ANY}>any</option>
            {facets.planes.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          participant{' '}
          <select
            value={participant}
            onChange={(event) => {
              setParticipant(event.target.value);
            }}
          >
            <option value={ANY}>any</option>
            {facets.participants.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          since{' '}
          <input
            aria-label="since"
            placeholder="ISO-8601"
            value={since}
            onChange={(event) => {
              setSince(event.target.value);
            }}
          />
        </label>
        <button type="button" disabled={busy} onClick={onRefresh}>
          sweep again
        </button>
      </div>

      <p data-testid="feed-count">
        {shown.length} of {events.length} events
      </p>

      <table aria-label="fabric events">
        <thead>
          <tr>
            <th scope="col">at</th>
            <th scope="col">participant</th>
            <th scope="col">plane</th>
            <th scope="col">kind</th>
            <th scope="col">world</th>
            <th scope="col">ids</th>
            <th scope="col">what</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((event) => (
            <tr key={event.id} data-testid={`event-${event.id}`} className={event.kind}>
              <td>{event.at}</td>
              <td>
                {event.participant}
                {event.standin ? ' (stand-in)' : ''}
              </td>
              <td>{event.plane}</td>
              <td>{event.kind}</td>
              <td>{event.world ?? '—'}</td>
              <td>
                {event.ids.map((id) => (
                  <code key={id}>{id} </code>
                ))}
              </td>
              <td>{event.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
