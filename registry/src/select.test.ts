import { describe, expect, it } from 'vitest';

import { createRegistry, selectFinetuneProvider, TRAINER_IDENTITY } from './index.ts';
import { PINAKES_FINETUNE } from './fixtures/providers.ts';
import TRAINER_MANIFEST from './fixtures/trainer.manifest.json';

const PINAKES_IDENTITY = 'pinakes:agent:finetune';

/**
 * FT-K: more than one `finetune` provider can match a job — agora's general trainer and
 * Pinakes's specialized provider both accept `text-generation`. These drive the registry's
 * disambiguation (KFT §8/§9): specialized first, then cheaper, explicit target honored, an
 * unbroken tie surfaced. `PINAKES_FINETUNE` is the stub specialized provider manifest.
 */
function bothProviders() {
  const registry = createRegistry();
  registry.register(TRAINER_MANIFEST);
  registry.register(PINAKES_FINETUNE);
  return registry;
}

describe('finetune provider selection (FT-K)', () => {
  it('prefers the more specialized provider over the general trainer', () => {
    const selection = bothProviders().selectFinetune({
      modality: 'text-generation',
      method: 'lora',
    });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(PINAKES_IDENTITY);
    expect(selection.reason).toBe('specialized');
  });

  it('specialization is decided before cost — the specialized provider wins even were it dearer', () => {
    // Registration order is trainer-then-Pinakes; the general trainer's text-generation rung
    // is the pricier one (1_800_000 vs 900_000). Neither order nor price is why Pinakes wins.
    const registry = createRegistry();
    registry.register(TRAINER_MANIFEST);
    registry.register(PINAKES_FINETUNE);
    const selection = registry.selectFinetune({ modality: 'text-generation' });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(PINAKES_IDENTITY);
    // And the winner carries a dialable address — discovery, not proxy (ADR-0001 §3).
    expect(selection.provider.address.endpoints).toBeDefined();
  });

  it('falls through to the general trainer for a modality the specialist does not serve', () => {
    const selection = bothProviders().selectFinetune({ modality: 'text-to-image', method: 'lora' });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(TRAINER_IDENTITY);
    // Sole server of that modality — no tiebreak needed.
    expect(selection.reason).toBe('sole');
  });

  it('falls through to the general trainer for a method the specialist does not serve', () => {
    // Pinakes advertises {sft, lora, qlora}; only the general trainer does `dpo`.
    const selection = bothProviders().selectFinetune({ modality: 'text-generation', method: 'dpo' });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(TRAINER_IDENTITY);
  });

  it('honors an explicit target provider over the specialization tiebreak', () => {
    const selection = bothProviders().selectFinetune({
      modality: 'text-generation',
      method: 'lora',
      provider: TRAINER_IDENTITY,
    });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(TRAINER_IDENTITY);
    expect(selection.reason).toBe('explicit');
  });

  it('rejects an explicit target that cannot serve the job — never silently reroutes', () => {
    // Pinakes cannot do text-to-image; naming it for such a job resolves to nothing, not the
    // general trainer (naming a provider is a demand, not a hint).
    const selection = bothProviders().selectFinetune({
      modality: 'text-to-image',
      provider: PINAKES_IDENTITY,
    });
    expect(selection.outcome).toBe('none');
  });

  it('surfaces an unbroken tie to the caller — never resolved by registration order', () => {
    // Two equally specialized, equally priced specialists for the same job.
    const registry = createRegistry();
    registry.register(PINAKES_FINETUNE);
    registry.register({
      ...PINAKES_FINETUNE,
      identity: 'other:agent:finetune',
      endpoints: { a2a: 'https://other.example/.well-known/agent-card.json' },
    });
    const selection = registry.selectFinetune({ modality: 'text-generation', method: 'lora' });
    expect(selection.outcome).toBe('tie');
    if (selection.outcome !== 'tie') return;
    expect(selection.candidates.map((m) => m.identity).sort()).toEqual([
      'other:agent:finetune',
      PINAKES_IDENTITY,
    ]);
  });

  it('breaks a specialization tie by lower cost (delta K)', () => {
    const registry = createRegistry();
    registry.register(PINAKES_FINETUNE); // est_units 900_000
    registry.register({
      ...PINAKES_FINETUNE,
      identity: 'dear:agent:finetune',
      endpoints: { a2a: 'https://dear.example/.well-known/agent-card.json' },
      capabilities: [
        {
          ...PINAKES_FINETUNE.capabilities![0],
          cost: { tier: 'local', meter: 'gpu-seconds', est_units: 5_000_000 },
        },
      ],
    });
    const selection = registry.selectFinetune({ modality: 'text-generation', method: 'lora' });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(PINAKES_IDENTITY);
    expect(selection.reason).toBe('cheaper');
  });

  it('finds nothing for a modality no indexed provider serves', () => {
    expect(bothProviders().selectFinetune({ modality: 'text-to-speech' }).outcome).toBe('none');
  });

  it('the general trainer advertises a broader surface than the specialist (AC2)', () => {
    // The stub is one modality × three methods; the trainer is five modalities. The breadth
    // gap is exactly what lets the registry tell a general provider from a specialized one.
    const registry = bothProviders();
    const matches = registry.find({ capability: 'finetune' });
    const trainer = matches.find((m) => m.identity === TRAINER_IDENTITY);
    const pinakes = matches.find((m) => m.identity === PINAKES_IDENTITY);
    const modalitiesOf = (identity: string) =>
      new Set(
        (registry.get(identity)?.manifest.capabilities ?? [])
          .filter((c) => c.name === 'finetune')
          .map((c) => c.modality),
      );
    expect(modalitiesOf(TRAINER_IDENTITY).size).toBeGreaterThan(modalitiesOf(PINAKES_IDENTITY).size);
    expect(trainer).toBeDefined();
    expect(pinakes).toBeDefined();
  });

  it('selectFinetuneProvider is a pure function over matches, independent of the registry', () => {
    const registry = bothProviders();
    const matches = registry.find({ capability: 'finetune' });
    const selection = selectFinetuneProvider(matches, {
      modality: 'text-generation',
      method: 'qlora',
    });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.provider.identity).toBe(PINAKES_IDENTITY);
  });
});
