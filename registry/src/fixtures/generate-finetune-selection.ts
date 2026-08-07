/**
 * Capture the registry's `selectFinetune` answers as a cross-language fixture (KFT §8, FT-K).
 *
 * The FT-K precedence lives in `select.ts` and nowhere else — but the caller that acts on it is
 * the **Python** dataset bridge (`trainer/src/agora_trainer/bridge.py`), which reads the JSON
 * this route returns and projects it onto a dialable provider. Nothing in either language would
 * otherwise notice if the shape drifted apart, so the answers are pinned here and read by BOTH
 * sides: `select.test.ts` asserts the registry still produces them, and
 * `trainer/tests/test_registry_selection.py` asserts the bridge still understands them.
 *
 * Regenerate whenever the selection shape or the provider fixtures change:
 *
 *     AGORA_CAPTURE=1 npx vite-node registry/src/fixtures/generate-finetune-selection.ts
 *
 * `vite-node`, not bare `node`: this reaches `registry.ts`, whose parameter property Node's
 * strip-only TypeScript loader rejects — the same constraint `examples/participant-starter`
 * keeps the SDK under. And an explicit `AGORA_CAPTURE` rather than an entry-point check,
 * because `vite-node` does not leave the script path in `process.argv` — so importing this
 * module from a test can never overwrite the fixture it is asserting against.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../registry.ts';
import type { FinetuneJobSpec, ProviderSelection } from '../select.ts';
import { SPECIALIZED_FINETUNE } from './providers.ts';
import TRAINER_MANIFEST from './trainer.manifest.json' with { type: 'json' };

/** One pinned selection: the job facets asked, and the verdict the registry gave. */
export interface SelectionCase {
  name: string;
  job: FinetuneJobSpec;
  selection: ProviderSelection;
}

/** The jobs whose verdicts the Python bridge is pinned against. */
export const SELECTION_JOBS: readonly { name: string; job: FinetuneJobSpec }[] = [
  // The specialist wins — the case a producer's local-only exhaust depends on (FT-K).
  { name: 'specialized', job: { modality: 'text-generation', method: 'lora' } },
  // A method only the general trainer serves — the fall-through.
  { name: 'general', job: { modality: 'text-generation', method: 'dpo' } },
  // Nothing serves it: the bridge must read `none`, not an empty success.
  { name: 'none', job: { modality: 'speech-to-speech' } },
];

export function captureSelections(): SelectionCase[] {
  const registry = createRegistry();
  registry.register(TRAINER_MANIFEST);
  registry.register(SPECIALIZED_FINETUNE);
  return SELECTION_JOBS.map(({ name, job }) => ({
    name,
    job,
    selection: registry.selectFinetune(job),
  }));
}

const HERE = dirname(fileURLToPath(import.meta.url));

if (process.env.AGORA_CAPTURE === '1') {
  const target = join(HERE, 'finetune-selection.json');
  writeFileSync(target, `${JSON.stringify(captureSelections(), null, 2)}\n`, 'utf8');
  console.log(`wrote ${target}`);
}
