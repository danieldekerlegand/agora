/**
 * Agora Studio — the shell.
 *
 * The backbone the topology graph, connection monitoring, the message viewer, the analytics
 * dashboards and the spec viewer all mount into. It ships with **nothing**: no apps, no
 * services, no connections, no roster. A fresh install is an empty stage, and it stays empty
 * until the user's own configuration supplies a cast — the same capability-never-caller rule
 * the rest of this tree obeys, so no participant is named in this source at all.
 *
 * Like the conformance console it is an **observer, not a hub** (ADR-0001 decision 7):
 * whatever it eventually draws, it draws from what it watched. Traffic between participants
 * never passes through Studio, and the shell holds no seam through which it could.
 *
 * What it renders today is the frame: who this is, where a view goes, and which koine
 * contracts this build speaks.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

import './App.css';

/** The koine contracts a Studio build speaks, in the order the footer lists them. */
const CONTRACTS = Object.entries(SPEC_VERSIONS);

export function App() {
  return (
    <div className="studio">
      <header className="studio-header">
        <h1>agora studio</h1>
        <p className="studio-tagline">
          the topology and observability view over your own fabric — an observer on real
          connections, never a hub
        </p>
      </header>

      <main className="studio-stage" aria-label="studio stage" />

      <footer className="studio-footer">
        <h2>koine contracts</h2>
        <ul>
          {CONTRACTS.map(([spec, version]) => (
            <li key={spec}>
              <span className="spec">{spec}</span> <span className="version">{version}</span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
