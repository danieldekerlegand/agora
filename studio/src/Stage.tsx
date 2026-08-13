/**
 * The stage — what the shell shows for a given backbone.
 *
 * Empty is the first thing anyone sees and a legitimate steady state, so it says so plainly:
 * zero participants, zero connections, and where a cast comes from. It is not a spinner and
 * not an error. Studio bundles no apps, no services and no connections, so an install nobody
 * has configured has genuinely nothing to draw.
 *
 * Populated, it is still only a read: labels, identities, advertised capability names, and the
 * links the participants hold with each other. Nothing here dials anything — the capability
 * names are text on a page, not buttons, because Studio watches this fabric rather than
 * driving it (ADR-0001 decision 7).
 */
import { isEmpty, labelOf, type Backbone } from './backbone.ts';

export interface StageProps {
  /** The picture to draw. Whatever was observed or configured — never anything from here. */
  backbone: Backbone;
}

export function Stage({ backbone }: StageProps) {
  if (isEmpty(backbone)) {
    return (
      <div className="studio-empty" role="status">
        <h2>nothing on the fabric yet</h2>
        <p className="studio-counts">0 participants · 0 connections</p>
        <p>
          Studio ships with no apps, no services and no connections. Point it at your own
          configuration and the cast that appears is exactly the one you described.
        </p>
      </div>
    );
  }

  const { participants, connections } = backbone;

  return (
    <div className="studio-cast">
      <p className="studio-counts">
        {participants.length} participants · {connections.length} connections
      </p>

      <section>
        <h2 id="studio-participants">participants</h2>
        <ul aria-labelledby="studio-participants">
          {participants.map((participant) => (
            <li key={participant.identity}>
              <span className="label">{labelOf(participant)}</span>{' '}
              <span className="identity">{participant.identity}</span>
              {participant.capabilities?.length ? (
                <span className="capabilities"> {participant.capabilities.join(' · ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 id="studio-connections">connections</h2>
        {connections.length === 0 ? (
          <p className="studio-none">none observed</p>
        ) : (
          <ul aria-labelledby="studio-connections">
            {connections.map((connection) => (
              <li key={`${connection.from}→${connection.to}:${connection.transport ?? ''}`}>
                <span className="identity">{connection.from}</span> →{' '}
                <span className="identity">{connection.to}</span>
                {connection.transport ? (
                  <span className="transport"> {connection.transport}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
