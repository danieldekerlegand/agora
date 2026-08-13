import { render, screen } from '@testing-library/react';
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

  it('states which koine contracts this build speaks', () => {
    render(<App />);
    const footer = screen.getByRole('contentinfo');
    for (const [spec, version] of Object.entries(SPEC_VERSIONS)) {
      expect(footer.textContent).toContain(spec);
      expect(footer.textContent).toContain(version);
    }
  });
});
