import { describe, expect, it } from 'vitest';

import { canonicalJson } from './json.ts';

describe('canonicalJson', () => {
  it('sorts object keys, at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('makes two orderings of the same object one byte string', () => {
    // The whole point (KGP §3): what a content address must not depend on.
    expect(canonicalJson({ world: 'w', relation: 'r' })).toBe(canonicalJson({ relation: 'r', world: 'w' }));
  });

  it('keeps array order — a sequence is content, not an accident', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, { b: null }] })).toBe('{"a":[1,{"b":null}]}');
  });

  it('escapes keys and strings the way JSON does', () => {
    expect(canonicalJson({ 'a"b': 'c\\d' })).toBe('{"a\\"b":"c\\\\d"}');
  });
});
