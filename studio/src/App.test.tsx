import { render, screen, within } from '@testing-library/react';
import { SPEC_VERSIONS } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { readStudioConfig } from './config.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('studio shell', () => {
  it('mounts and names itself', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /agora studio/i })).toBeTruthy();
  });

  it('gives a view somewhere to mount', () => {
    render(<App />);
    expect(screen.getByRole('main', { name: 'studio stage' })).toBeTruthy();
  });

  it('is empty on a fresh install: no config, no cast, and it says so', () => {
    // The whole point of the backbone. Nothing is bundled, so an unconfigured Studio has
    // genuinely nothing to draw — and shows that rather than a roster it invented.
    render(<App />);
    const stage = screen.getByRole('main', { name: 'studio stage' });
    expect(within(stage).getByRole('status').textContent).toContain(
      '0 participants · 0 connections',
    );
    expect(within(stage).queryAllByRole('listitem')).toEqual([]);
  });

  it('draws whatever cast it is handed at runtime, and only that', () => {
    render(
      <App
        backbone={{
          participants: [{ identity: 'example:agent:alpha', label: 'Alpha' }],
          connections: [],
        }}
      />,
    );
    const stage = screen.getByRole('main', { name: 'studio stage' });
    const listed = within(stage).getByRole('list', { name: 'participants' });
    expect(within(listed).getAllByRole('listitem')).toHaveLength(1);
    expect(stage.textContent).toContain('Alpha');
    expect(within(stage).queryByRole('status')).toBeNull();
  });

  it('draws the cast a user config described, and only that', () => {
    // The whole path in one go: the user's own file, read at runtime, becomes what is on screen.
    const { backbone, problems } = readStudioConfig(
      JSON.stringify({
        format: 'agora.studio.config/v1',
        participants: [{ identity: 'example:agent:alpha', label: 'Alpha' }],
        connections: [],
      }),
    );
    render(<App backbone={backbone} problems={problems} />);
    const stage = screen.getByRole('main', { name: 'studio stage' });
    expect(within(stage).getAllByRole('listitem')).toHaveLength(1);
    expect(stage.textContent).toContain('Alpha');
    expect(within(stage).queryByRole('region', { name: 'config problems' })).toBeNull();
  });

  it('shows what a config said that it could not read, rather than dropping it silently', () => {
    const { backbone, problems } = readStudioConfig('{ not json');
    render(<App backbone={backbone} problems={problems} />);
    const stage = screen.getByRole('main', { name: 'studio stage' });
    const reported = within(stage).getByRole('region', { name: 'config problems' });
    expect(within(reported).getAllByRole('listitem')).toHaveLength(1);
    expect(within(stage).getByRole('status').textContent).toContain('0 participants');
  });

  it('states which koine contracts this build speaks', () => {
    render(<App />);
    const footer = screen.getByRole('contentinfo');
    for (const [spec, version] of Object.entries(SPEC_VERSIONS)) {
      expect(footer.textContent).toContain(spec);
      expect(footer.textContent).toContain(version);
    }
  });
});
