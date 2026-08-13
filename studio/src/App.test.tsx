import { render, screen, within } from '@testing-library/react';
import { SPEC_VERSIONS } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';

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

  it('states which koine contracts this build speaks', () => {
    render(<App />);
    const footer = screen.getByRole('contentinfo');
    for (const [spec, version] of Object.entries(SPEC_VERSIONS)) {
      expect(footer.textContent).toContain(spec);
      expect(footer.textContent).toContain(version);
    }
  });
});
