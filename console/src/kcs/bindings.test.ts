import { describe, expect, it } from 'vitest';

import { bind, BindingError, lookup } from './bindings.ts';
import type { Json } from '@agora/schemas';

const bindings = new Map<string, Json>([
  ['completion', { tier: 'placeholder', cost: { actual_units: 0 }, choices: ['first'] }],
]);

describe('${step.path} bindings', () => {
  it('keeps the type of a whole-string binding', () => {
    // The number matters: `cost_within_ceiling` compares it against a numeric ceiling.
    expect(bind('${completion.cost.actual_units}', bindings)).toBe(0);
    expect(bind('${completion.tier}', bindings)).toBe('placeholder');
  });

  it('interpolates an embedded binding into a string', () => {
    expect(bind('served by ${completion.tier}', bindings)).toBe('served by placeholder');
  });

  it('indexes into an array', () => {
    expect(lookup('completion.choices.0', bindings)).toBe('first');
  });

  it('walks arrays and objects', () => {
    expect(bind({ a: ['${completion.tier}', 2], b: true }, bindings)).toEqual({
      a: ['placeholder', 2],
      b: true,
    });
  });

  it('throws rather than substituting undefined', () => {
    // A scenario whose subject never ran must not resolve to a quietly-green report.
    expect(() => bind('${missing.tier}', bindings)).toThrow(BindingError);
    expect(() => bind('${completion.nope}', bindings)).toThrow(/no nope in completion/);
    expect(() => bind('${completion.tier.deeper}', bindings)).toThrow(/is not an object/);
  });

  it('leaves a string with no binding alone', () => {
    expect(bind('In one sentence, what is the agora commons?', bindings)).toBe(
      'In one sentence, what is the agora commons?',
    );
  });
});
