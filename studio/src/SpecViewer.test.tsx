/**
 * Selecting a participant shows what that participant advertises — and only that.
 *
 * The cast comes from a real registry, so what is on screen traces back to a manifest somebody
 * published rather than to anything in `studio/src`. The manifests are sample data authored
 * here (`.example` hostnames), and swapping them swaps the whole view.
 */
import { createRegistry } from '@agora/registry';
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SpecViewer } from './SpecViewer.tsx';
import { discoverTopology, topologyOf, type Topology } from './topology.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

const kcb_version = SPEC_VERSIONS.kcb;

const RENDERER: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:renderer',
  endpoints: { mcp: 'https://renderer.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
    },
  ],
};

const LIBRARIAN: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:librarian',
  endpoints: { a2a: 'https://librarian.example/.well-known/agent-card.json' },
  produces: [{ plane: 'knowledge', dialect: 'sample' }],
};

async function graph(...manifests: CapabilityManifest[]): Promise<Topology> {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return discoverTopology({ discovery: registry });
}

/** The contract names on screen, in the order the panel lists them. */
function listed(): string[] {
  return within(screen.getByRole('list', { name: 'koine contracts' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.spec')?.textContent ?? '');
}

describe('the spec viewer', () => {
  it('opens on the first participant and renders exactly the contracts it advertises', async () => {
    render(<SpecViewer topology={await graph(RENDERER, LIBRARIAN)} />);

    expect(listed()).toEqual(['kinp', 'kcb', 'kmi']);
    const panel = screen.getByRole('region', { name: 'spec viewer' });
    expect(panel.textContent).toContain(`this build speaks ${SPEC_VERSIONS.kcb}`);
    expect(panel.textContent).toContain('manifest.capabilities[0].inputs[0].plane');
  });

  it('renders the other participant, and only its contracts, when one is selected', async () => {
    render(<SpecViewer topology={await graph(RENDERER, LIBRARIAN)} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: LIBRARIAN.identity } });

    expect(listed()).toEqual(['kinp', 'kgp', 'kcb']);
    expect(screen.getByRole('region', { name: 'spec viewer' }).textContent).not.toContain('kmi');
  });

  it('shows the manifest the participant published, verbatim', async () => {
    render(<SpecViewer topology={await graph(LIBRARIAN)} />);

    const documents = within(screen.getByRole('list', { name: 'advertised documents' }));
    const [document] = documents.getAllByRole('listitem');
    expect(document?.textContent).toContain('kcb-manifest');
    expect(document?.textContent).toContain('indexed');
    expect(document?.querySelector('.document')?.textContent).toBe(
      JSON.stringify(LIBRARIAN, null, 2),
    );
  });

  it('says plainly that a participant nobody published for advertises nothing', () => {
    const observed = topologyOf({
      observed: { participants: [{ identity: 'sample:agent:seen-only' }], connections: [] },
    });
    render(<SpecViewer topology={observed} />);

    const panel = screen.getByRole('region', { name: 'spec viewer' });
    expect(panel.textContent).toContain('advertises no specs');
    expect(within(panel).queryAllByRole('listitem')).toEqual([]);
  });

  it('reads specs and never drives them: no button, no link, on any of it', async () => {
    render(<SpecViewer topology={await graph(RENDERER, LIBRARIAN)} />);

    const panel = screen.getByRole('region', { name: 'spec viewer' });
    expect(within(panel).queryAllByRole('button')).toEqual([]);
    expect(within(panel).queryAllByRole('link')).toEqual([]);
  });

  it('draws nothing to pick from when the graph is empty', () => {
    render(<SpecViewer topology={{ nodes: [], edges: [] }} />);

    expect(screen.getByRole('region', { name: 'spec viewer' }).textContent).toContain(
      'no participant to read',
    );
  });
});
