/**
 * Step bindings — `${<step-id>.<path>}` (KCS §2.1, delta M).
 *
 * A multi-step scenario has to thread values that only exist at run time: the provisional
 * entity id an `invoke` minted, a resolved identity, the tier a router picked. Bindings are
 * how a later step or assertion names one.
 *
 * Two rules earn their keep:
 *
 * 1. **A whole-string binding keeps its type.** `"${call.cost.actual_units}"` resolves to
 *    the number `0`, not `"0"`, so `cost_within_ceiling` compares numbers. Only an embedded
 *    binding (`"tier=${call.tier}"`) interpolates.
 * 2. **An unresolvable binding throws.** Silently substituting `undefined` would turn a
 *    scenario that never ran its subject into a green report.
 */
import type { Json } from '@agora/schemas';

/** Thrown when a binding names a step or a path that the run does not have. */
export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

const WHOLE = /^\$\{([^}]+)\}$/;
const EMBEDDED = /\$\{([^}]+)\}/g;

/** The values a run has bound so far: step id → that step's output. */
export type Bindings = ReadonlyMap<string, Json>;

/** Resolve every `${…}` in `value`, recursively through arrays and objects. */
export function bind(value: Json, bindings: Bindings): Json {
  if (typeof value === 'string') return bindString(value, bindings);
  if (Array.isArray(value)) return value.map((entry) => bind(entry, bindings));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, bindings)]));
  }
  return value;
}

function bindString(value: string, bindings: Bindings): Json {
  const whole = WHOLE.exec(value);
  if (whole?.[1] !== undefined) return lookup(whole[1], bindings);
  return value.replace(EMBEDDED, (_match, reference: string) => {
    const resolved = lookup(reference, bindings);
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}

/** Read one `step.path` reference. Exported because assertions take bare references too. */
export function lookup(reference: string, bindings: Bindings): Json {
  const [stepId, ...path] = reference.split('.');
  if (stepId === undefined || !bindings.has(stepId)) {
    throw new BindingError(`\${${reference}} names no step that has produced a value`);
  }
  let current = bindings.get(stepId) as Json;
  for (const [index, key] of path.entries()) {
    if (typeof current !== 'object' || current === null) {
      throw new BindingError(`\${${reference}} — ${[stepId, ...path.slice(0, index)].join('.')} is not an object`);
    }
    const next = Array.isArray(current) ? current[Number(key)] : current[key];
    if (next === undefined) {
      throw new BindingError(`\${${reference}} — no ${key} in ${[stepId, ...path.slice(0, index)].join('.')}`);
    }
    current = next;
  }
  return current;
}
