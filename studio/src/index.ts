/**
 * `@agora/studio` — the studio shell's surface.
 *
 * Source-first like every other area here: this file *is* the package's entry point, nothing
 * is emitted. Views land alongside `App` as they are built; the shell exports no participant
 * data, because it holds none — everything on this surface is a component, a shape, or a
 * function over data the caller supplies.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

export { App, type AppProps } from './App.tsx';
export { Stage, type StageProps } from './Stage.tsx';
export {
  backboneOf,
  EMPTY_BACKBONE,
  isEmpty,
  labelOf,
  type Backbone,
  type Connection,
  type Participant,
} from './backbone.ts';

export interface StudioDescription {
  kcbVersion: string;
  /** Always false — ADR-0001 decisions 3 and 7. Studio draws what it watched; it is not a
   * path between two participants, and there is no verb on this surface that could become one. */
  relaysPayloads: false;
  /** Always 0. Whatever is on screen came in at runtime; nothing ships in the bundle. */
  bundledParticipants: 0;
}

/**
 * What this build is, in the terms the rest of the tree describes itself in (`describeRegistry`,
 * `describeResolver`). Both invariants are asserted in the test suite, so flipping either one
 * fails the gate rather than quietly changing what Studio is.
 */
export function describeStudio(): StudioDescription {
  return {
    kcbVersion: SPEC_VERSIONS.kcb,
    relaysPayloads: false,
    bundledParticipants: 0,
  };
}
