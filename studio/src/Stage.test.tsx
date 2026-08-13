/**
 * What the stage shows for a backbone — the empty first-run state, and a cast that is exactly
 * the data the caller passed in.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Stage } from './Stage.tsx';
import { backboneOf, EMPTY_BACKBONE } from './backbone.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('an unconfigured stage', () => {
  it('says plainly that there is nothing, rather than pretending to load', () => {
    render(<Stage backbone={EMPTY_BACKBONE} />);
    const empty = screen.getByRole('status');
    expect(empty.textContent).toContain('0 participants · 0 connections');
    expect(screen.queryAllByRole('list')).toEqual([]);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });
});

describe('a configured stage', () => {
  const backbone = backboneOf({
    participants: [
      { identity: 'example:agent:alpha', label: 'Alpha', capabilities: ['summarize.text'] },
      { identity: 'example:service:beta' },
    ],
    connections: [{ from: 'example:agent:alpha', to: 'example:service:beta', transport: 'a2a' }],
  });

  it('lists every participant the caller supplied, and nothing else', () => {
    render(<Stage backbone={backbone} />);
    const listed = within(screen.getByRole('list', { name: 'participants' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('Alpha');
    expect(listed[0]).toContain('summarize.text');
    expect(listed[1]).toContain('example:service:beta');
  });

  it('draws the links between them as observed facts, not as controls', () => {
    render(<Stage backbone={backbone} />);
    const edges = within(screen.getByRole('list', { name: 'connections' }))
      .getAllByRole('listitem')
      .map((edge) => edge.textContent ?? '');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toContain('a2a');
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});
