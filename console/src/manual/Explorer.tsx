/**
 * The capability explorer — manual mode's UI.
 *
 * Browse what the registry advertises (per provider, plane-typed ports), pick a capability,
 * and compose a request from a form the *port schema* generated. The send button hands the
 * composed request up to the App, which compiles it with `manualScenario` and runs it
 * through the same `runConformance` a library scenario goes through — this component owns
 * no transport, no discovery and no log, which is exactly the point.
 *
 * The form's fields are not authored here. They come out of `fieldsFor`, one per declared
 * input port, and whether a field takes JSON or a KINP id comes out of the port's plane. A
 * hand-written form per capability would drift from the manifest the moment a provider
 * changed one — and the operator would find out by sending the wrong thing.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  fieldsFor,
  type CataloguedCapability,
  type CataloguedProvider,
  type ManualVerb,
} from './catalogue.ts';
import {
  ManualRequestError,
  portValuesFrom,
  type ManualRequest,
} from './request.ts';

export interface ExplorerProps {
  providers: readonly CataloguedProvider[];
  /** True while a request is in flight — the console runs one exchange at a time. */
  busy: boolean;
  /** Why a provider is missing, when one is (from the same discovery a run uses). */
  problems?: readonly string[];
  onSend: (request: ManualRequest) => void;
}

export function Explorer({ providers, busy, problems = [], onSend }: ExplorerProps) {
  const [identity, setIdentity] = useState(providers[0]?.identity);
  const provider = providers.find((entry) => entry.identity === identity) ?? providers[0];
  const [verb, setVerb] = useState<ManualVerb>('invoke');
  const [capabilityName, setCapabilityName] = useState<string>();
  const capability =
    provider?.capabilities.find((entry) => entry.name === capabilityName) ??
    provider?.capabilities[0];
  const fields = useMemo(() => (capability === undefined ? [] : fieldsFor(capability)), [capability]);
  const [texts, setTexts] = useState<string[]>([]);
  const [budget, setBudget] = useState('');
  const [asset, setAsset] = useState('');
  const [entityId, setEntityId] = useState('');
  const [problem, setProblem] = useState<string>();

  // A new capability is a new form. Carrying the old text over would post one capability's
  // payload into another's ports, which the port types would not necessarily catch.
  useEffect(() => {
    setTexts(fields.map(() => ''));
  }, [fields]);

  // `resolve` is the console's own verb; every other one needs a provider that serves it.
  const verbs: ManualVerb[] = [...(provider?.verbs ?? []), 'resolve'];
  const offered: ManualVerb = verbs.includes(verb) ? verb : (verbs[0] ?? 'resolve');

  const send = (): void => {
    try {
      setProblem(undefined);
      onSend(compose());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const compose = (): ManualRequest => {
    if (offered === 'resolve') {
      if (entityId.trim() === '') throw new ManualRequestError('a resolve needs an id to resolve');
      return { verb: 'resolve', ref: { id: entityId.trim() } };
    }
    if (provider === undefined) throw new ManualRequestError('nothing was discovered to dial');
    if (offered === 'fetch') {
      if (asset.trim() === '') throw new ManualRequestError('a fetch needs an asset id');
      return {
        verb: 'fetch',
        participant: provider.identity,
        standin: provider.standin,
        asset: asset.trim(),
      };
    }
    if (capability === undefined) {
      throw new ManualRequestError(`${provider.identity} declares no capability to invoke`);
    }
    const ceiling = budget.trim();
    if (ceiling !== '' && !Number.isFinite(Number(ceiling))) {
      throw new ManualRequestError(`the ceiling ${ceiling} is not a number of budget units`);
    }
    return {
      verb: 'invoke',
      participant: provider.identity,
      standin: provider.standin,
      capability: capability.name,
      inputs: portValuesFrom(fields, texts),
      ...(ceiling === '' ? {} : { budgetUnits: Number(ceiling) }),
    };
  };

  return (
    <section aria-label="capability explorer" className="explorer">
      <h2>Capability explorer</h2>
      <p className="summary">
        What the registry advertises, composed by hand and sent over the same direct
        connection a scenario uses. No scenario file, and nothing relayed through here.
      </p>

      {problems.map((entry) => (
        <p role="alert" key={entry}>
          {entry}
        </p>
      ))}

      {providers.length === 0 ? (
        <p role="status">no provider has been discovered yet</p>
      ) : (
        <>
          <div className="composer">
            <label>
              provider{' '}
              <select
                value={provider?.identity ?? ''}
                onChange={(event) => {
                  setIdentity(event.target.value);
                  setCapabilityName(undefined);
                }}
              >
                {providers.map((entry) => (
                  <option key={entry.identity} value={entry.identity}>
                    {entry.identity}
                    {entry.standin === undefined ? '' : ' (stand-in)'}
                  </option>
                ))}
              </select>
            </label>

            <label>
              verb{' '}
              <select
                value={offered}
                onChange={(event) => {
                  setVerb(event.target.value as ManualVerb);
                }}
              >
                {verbs.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>

            {offered === 'invoke' && (
              <label>
                capability{' '}
                <select
                  value={capability?.name ?? ''}
                  onChange={(event) => {
                    setCapabilityName(event.target.value);
                  }}
                >
                  {provider?.capabilities.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {provider !== undefined && <ProviderDetail provider={provider} />}

          {offered === 'invoke' && capability !== undefined && (
            <>
              <CapabilityDetail capability={capability} />
              <div className="ports">
                {fields.map((field, index) => (
                  <label key={`${field.label}-${index}`} className="port">
                    <span>
                      input {index + 1} · {field.label} · {field.entry}
                    </span>
                    <textarea
                      aria-label={`input ${index + 1} · ${field.label}`}
                      placeholder={field.placeholder}
                      rows={field.entry === 'ref' ? 1 : 3}
                      value={texts[index] ?? ''}
                      onChange={(event) => {
                        setTexts((current) =>
                          current.map((text, at) => (at === index ? event.target.value : text)),
                        );
                      }}
                    />
                  </label>
                ))}
              </div>
              <label className="port">
                <span>ceiling · budget units (blank sends none)</span>
                <input
                  aria-label="ceiling · budget units"
                  value={budget}
                  onChange={(event) => {
                    setBudget(event.target.value);
                  }}
                />
              </label>
            </>
          )}

          {offered === 'fetch' && (
            <label className="port">
              <span>asset · a KINP asset id (KMI §7 — bytes are fetched by id)</span>
              <input
                aria-label="asset id"
                value={asset}
                onChange={(event) => {
                  setAsset(event.target.value);
                }}
              />
            </label>
          )}

          {offered === 'resolve' && (
            <label className="port">
              <span>entity · a KINP id to resolve (KINP §8)</span>
              <input
                aria-label="entity id"
                value={entityId}
                onChange={(event) => {
                  setEntityId(event.target.value);
                }}
              />
            </label>
          )}

          {problem !== undefined && <p role="alert">{problem}</p>}

          <button type="button" disabled={busy} onClick={send}>
            send
          </button>
        </>
      )}
    </section>
  );
}

/** What the provider published about itself — including what it will demand of a caller. */
function ProviderDetail({ provider }: { provider: CataloguedProvider }) {
  return (
    <dl className="detail" aria-label="provider detail">
      <dt>endpoints</dt>
      <dd>
        {Object.entries(provider.endpoints)
          .map(([name, url]) => `${name}: ${url}`)
          .join(' · ') || 'none published'}
      </dd>
      <dt>grants required</dt>
      <dd data-testid="grants-required">
        {provider.grantsRequired.length === 0 ? 'none stated' : provider.grantsRequired.join(', ')}
      </dd>
      {provider.standin !== undefined && (
        <>
          <dt>stand-in</dt>
          <dd>{provider.standin} — this peer has not adopted the bus; answers are a fixture</dd>
        </>
      )}
    </dl>
  );
}

/** The capability as its manifest declares it: where it is dialed, its ports, its price. */
function CapabilityDetail({ capability }: { capability: CataloguedCapability }) {
  return (
    <dl className="detail" aria-label="capability detail">
      <dt>dials</dt>
      <dd data-testid="capability-endpoint">{capability.endpoint ?? 'no address published'}</dd>
      <dt>planes</dt>
      <dd>{capability.planes.join(', ') || 'none declared'}</dd>
      <dt>projected cost</dt>
      <dd data-testid="capability-cost">
        {capability.unpriced
          ? 'unpriced — not the same as free'
          : `${capability.estUnits ?? 0} budget units${
              capability.tier === undefined ? '' : ` at tier ${capability.tier}`
            }${capability.basis === undefined ? '' : ` (${capability.basis})`}`}
      </dd>
    </dl>
  );
}
