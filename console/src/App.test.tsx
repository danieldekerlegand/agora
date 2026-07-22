import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('console shell', () => {
  it('mounts and names itself', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /conformance console/i })).toBeTruthy();
  });

  it('surfaces the identities it discovered from the other areas', () => {
    render(<App />);
    expect(screen.getByText('agora:agent:registry')).toBeTruthy();
    expect(screen.getByText('agora:agent:resolver')).toBeTruthy();
  });
});
