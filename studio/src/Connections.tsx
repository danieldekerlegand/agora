/**
 * The connection panel — what each link in the user's setup is doing, and for how long.
 *
 * The graph says which connections exist; this says whether they work. Every row is a
 * {@link ConnectionRecord}: a status somebody actually observed over the real direct link
 * (`connection.ts`), how long it has held that status, and — when it is unhappy — the far
 * end's own words for why, most recent first. Nothing on the row is computed here.
 *
 * It is text and only text, for the same reason the graph is (ADR-0001 decisions 3 and 7):
 * there is no retry button, no "reconnect", no verb at all. Studio watches these connections;
 * it is not on them, and a panel that could restart somebody else's link would be the first
 * step to becoming the hub this tree exists not to be.
 *
 * Nothing here fabricates a reading. A connection nobody probed says so; a fabric with no
 * connections at all draws an empty panel rather than a reassuring one, the same way an
 * unconfigured Studio draws an empty stage.
 */
import { uptimeOf, type ConnectionError, type ConnectionRecord } from './history.ts';

export interface ConnectionsProps {
  /** The connections to report on — the last monitoring pass, folded (`trackConnections`). */
  connections: readonly ConnectionRecord[];
}

export function Connections({ connections }: ConnectionsProps) {
  return (
    <section className="studio-health">
      <h2 id="studio-connection-health">connection health</h2>
      {connections.length === 0 ? (
        <p className="studio-none">no connections to watch</p>
      ) : (
        <ul aria-labelledby="studio-connection-health">
          {connections.map((connection) => (
            <li
              key={connection.key}
              className={`studio-connection studio-connection-${connection.health.status}`}
            >
              <ConnectionRow connection={connection} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One connection: who dials whom over what, how it is doing, and how long it has been doing it.
 *
 * `up` shows uptime, because that is the question a healthy link raises. Anything else shows
 * how long it has been that way and what it said, because that is the question an unhealthy
 * one raises. `unknown` shows neither and says why it has nothing to show — the reading is
 * "nobody looked", and dressing it as either health or failure would be a lie in one direction.
 */
function ConnectionRow({ connection }: { connection: ConnectionRecord }) {
  const { health, errors } = connection;
  const uptime = uptimeOf(connection);

  return (
    <>
      <span className="identity">{connection.from}</span> →{' '}
      <span className="identity">{connection.to}</span>
      {connection.transport ? <span className="transport"> {connection.transport}</span> : null}
      <span className="status"> {health.status}</span>
      {uptime !== undefined ? <span className="uptime"> up {elapsed(uptime)}</span> : null}
      {uptime === undefined && connection.heldMs !== undefined ? (
        <span className="held"> for {elapsed(connection.heldMs)}</span>
      ) : null}
      {health.latencyMs !== undefined ? (
        <span className="latency"> {Math.round(health.latencyMs)}ms</span>
      ) : null}
      {health.status === 'unknown' && health.detail ? (
        <span className="unwatched"> {health.detail}</span>
      ) : null}
      {errors.length > 0 ? (
        <ul className="studio-errors">
          {errors.map((error) => (
            <li key={`${error.status}:${error.detail}`}>
              <ErrorRow error={error} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** One failure, in the far end's words — with how many readings in a row have said it. */
function ErrorRow({ error }: { error: ConnectionError }) {
  return (
    <>
      <span className="error-status">{error.status}</span>{' '}
      <span className="error-detail">{error.detail}</span>
      {error.count > 1 ? <span className="error-count"> ×{error.count}</span> : null}
    </>
  );
}

/** A duration a human reads at a glance. Coarse on purpose: uptime is not a stopwatch. */
function elapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
