/**
 * The spec viewer — pick a participant, read what it says it is.
 *
 * The graph says who is on the fabric and the health panel says whether their links work.
 * This says what they *claim*: the koine contracts each participant advertises, cited to the
 * line of its own document that advertises them, and the documents themselves verbatim.
 *
 * Everything on screen came out of `specs.ts`, which read it out of the participant's own
 * AgentCard and KCB manifest. Nothing is fetched here (Studio opens no transport), nothing is
 * inferred, and no contract is defined — a contract Studio has never heard of still renders,
 * because what is rendered is the participant's claim rather than Studio's checklist.
 *
 * Beside every claim sits what `@agora/schemas` made of it (`checks.ts`) — valid, invalid with
 * the checker's own reason, or unjudged where no rule exists to apply. A claim and its ruling
 * are never separated: a document shown without one reads as vouched for, and the difference
 * between a participant SAYING it speaks KCB and its document VALIDATING as KCB is the whole
 * reason this panel is worth reading.
 *
 * The one control on it is the participant picker, and it is a view control: it changes which
 * claim is on screen and touches nothing on the fabric. There is no button on a contract and
 * none on a document, for the same reason there is none on a node (ADR-0001 decisions 3 and
 * 7) — a spec is something to read, and reading it is the whole of what Studio does here.
 *
 * A participant nobody handed a document for advertises nothing, and the panel says exactly
 * that: the empty spec view, the same honest blank as an unconfigured stage.
 */
import { useState } from 'react';

import { labelOf } from './backbone.ts';
import { checkView, type ArtifactCheck, type ContractCheck } from './checks.ts';
import {
  advertisementOf,
  isEmptyView,
  specViewOf,
  type SpecAdvertisement,
  type SpecArtifact,
  type SpecView,
} from './specs.ts';
import type { Topology } from './topology.ts';

export interface SpecViewerProps {
  /** The fabric to pick a participant from — the same graph everything else on the stage draws. */
  topology: Topology;
  /**
   * The AgentCards the host read at the participants' own well-known addresses, by identity.
   * A prop like every other document seam: Studio dials nobody, so a host that reads cards
   * hands them in, and one that reads none shows whatever discovery indexed and no more.
   */
  cards?: Readonly<Record<string, unknown>>;
  /** Which participant to open on. Without one, the first on the graph. */
  selected?: string;
}

export function SpecViewer({ topology, cards = {}, selected }: SpecViewerProps) {
  const [picked, setPicked] = useState<string | null>(null);

  const { nodes } = topology;
  // A participant that has left the graph falls back to the first one rather than blanking the
  // panel: the selection is a view's preference, and it has no standing to outlive its subject.
  const chosen = nodes.find((node) => node.identity === (picked ?? selected)) ?? nodes[0];

  return (
    <section className="studio-specs" aria-label="spec viewer">
      <h2 id="studio-specs">advertised specs</h2>
      {chosen === undefined ? (
        <p className="studio-none">no participant to read</p>
      ) : (
        <>
          <label className="studio-spec-pick">
            participant{' '}
            <select
              value={chosen.identity}
              onChange={(event) => setPicked(event.target.value)}
            >
              {nodes.map((node) => (
                <option key={node.identity} value={node.identity}>
                  {labelOf(node)}
                </option>
              ))}
            </select>
          </label>
          <SpecPanel view={specViewOf(advertisementOf(chosen, cards[chosen.identity]))} />
        </>
      )}
    </section>
  );
}

/**
 * What one participant advertises: the contracts it names, the documents it named them in, and
 * what `@agora/schemas` made of each. The claim and the ruling on it are never shown apart —
 * a document printed without its verdict reads as vouched for, and Studio vouches for nothing.
 */
function SpecPanel({ view }: { view: SpecView }) {
  if (isEmptyView(view)) {
    return (
      <p className="studio-none">
        {view.identity} advertises no specs Studio was handed — nothing was discovered for it,
        and no card was read.
      </p>
    );
  }

  const checked = checkView(view);
  const contractChecks = new Map(checked.contracts.map((check) => [check.spec, check]));
  const artifactChecks = new Map(
    checked.artifacts.map((check) => [`${check.source}:${check.at}`, check]),
  );

  return (
    <>
      <section>
        <h3 id="studio-spec-contracts">koine contracts</h3>
        {view.contracts.length === 0 ? (
          <p className="studio-none">its documents name no contract</p>
        ) : (
          <ul aria-labelledby="studio-spec-contracts">
            {view.contracts.map((contract) => (
              <li key={contract.spec} className="studio-contract">
                <ContractRow contract={contract} check={contractChecks.get(contract.spec)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 id="studio-spec-artifacts">advertised documents</h3>
        <ul aria-labelledby="studio-spec-artifacts">
          {view.artifacts.map((artifact) => (
            <li key={`${artifact.source}:${artifact.at}`} className="studio-artifact">
              <ArtifactRow
                artifact={artifact}
                check={artifactChecks.get(`${artifact.source}:${artifact.at}`)}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * One contract: which it is, the version the participant declared, the version this build
 * pins, where the claim was read — and what checking one against the other concluded.
 *
 * The two versions sit side by side rather than being reconciled — a participant on a spec
 * this build does not speak is a real and ordinary state of a fabric, and where `@agora/schemas`
 * states no rule to settle it the verdict says `unjudged` and leaves the judging to the reader.
 * A contract this build pins no version for (KMI) shows the blank it actually has.
 */
function ContractRow({ contract, check }: { contract: SpecAdvertisement; check: ContractCheck | undefined }) {
  return (
    <>
      <span className="spec">{contract.spec}</span>
      <VerdictRow check={check} />
      {contract.declared ? (
        <span className="declared"> advertises {contract.declared}</span>
      ) : (
        <span className="declared"> version unstated</span>
      )}
      {contract.pinned ? (
        <span className="pinned"> · this build speaks {contract.pinned}</span>
      ) : (
        <span className="pinned"> · this build pins no version</span>
      )}
      <span className="evidence"> {contract.evidence.join(' · ')}</span>
    </>
  );
}

/**
 * One document, as the participant published it — and whether it validates.
 *
 * Rendered with `JSON.stringify`, not canonicalised: key order is the author's, and a viewer
 * that re-sorted a document would be showing its own rendering of the bytes rather than the
 * bytes. `served` versus `indexed` stays on the row because the provider is authoritative and
 * the index is a cache (KCB §3) — when the two differ, that is the finding.
 *
 * The verdict rides above the document rather than replacing it: a reader who does not believe
 * the ruling has the bytes it was reached from, right there, to check it against.
 */
function ArtifactRow({ artifact, check }: { artifact: SpecArtifact; check: ArtifactCheck | undefined }) {
  return (
    <>
      <span className="kind">{artifact.kind}</span>{' '}
      <span className="source">{artifact.source}</span>{' '}
      <span className="at">{artifact.at}</span>
      <VerdictRow check={check} />
      <pre className="document">{show(artifact.document)}</pre>
    </>
  );
}

/**
 * What the schemas package concluded, and why.
 *
 * The reason is shown whenever there is one — an `invalid` without it is an accusation, and an
 * `unjudged` without it looks like an omission rather than the honest blank it is. The checker
 * that ruled is named too, because the rule lives in `@agora/schemas` and a reader is entitled
 * to go read the rule rather than take this panel's word for it.
 */
function VerdictRow({ check }: { check: ContractCheck | ArtifactCheck | undefined }) {
  if (!check) return null;
  return (
    <>
      {' '}
      <span className={`verdict ${check.verdict}`}>{check.verdict}</span>
      <span className="checker"> per {check.by}</span>
      {check.reasons.length > 0 && <span className="reason"> — {check.reasons.join('; ')}</span>}
    </>
  );
}

/** A document as text. Anything JSON cannot carry is shown as what it is, not as an empty box. */
function show(document: unknown): string {
  try {
    return JSON.stringify(document, null, 2) ?? String(document);
  } catch {
    return String(document);
  }
}
