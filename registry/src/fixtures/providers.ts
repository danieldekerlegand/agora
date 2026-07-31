/**
 * Synthetic providers for the registry's tests — SAMPLE DATA, not a cast the registry knows.
 *
 * Nothing in `registry/src/` reads a name from here: selection and path search are driven by
 * the manifests a caller registers, and these exist only so the tests have shapes. They are
 * modeled on real ones rather than `foo`/`bar` — the KCB §2 example composer (mood in, MIDI
 * out), a narrator, a renderer, a describer — so the path tests read as the pressure test's
 * real question ("compose a score from a mood") instead of a graph puzzle. The namespaces
 * they are spelled with are the ecosystem agora was extracted from; treat them as fixture
 * text, exactly like the `.example` hostnames beside them.
 *
 * The provider-router's manifest is *not* here: it is captured verbatim from the running
 * service in `provider-router.manifest.json`, and `provider-router/tests/test_manifest.py`
 * asserts the two agree.
 */
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';

const kcb_version = SPEC_VERSIONS.kcb;

/** Knowledge in, media out — the cross-plane leg (KCB §2.1 delta F). Paid. */
export const COMPOSER: CapabilityManifest = {
  kcb_version,
  identity: 'orchestrator:agent:composer',
  endpoints: { a2a: 'https://composer.example/.well-known/agent-card.json' },
  consumes: [{ plane: 'knowledge', shape: 'mood-descriptor' }],
  produces: [{ plane: 'media', media_types: ['audio/midi'] }],
  capabilities: [
    {
      name: 'compose',
      inputs: [{ plane: 'knowledge', shape: 'mood-descriptor' }],
      outputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      cost: { tier: 'paid', est_units: 1200 },
    },
  ],
};

/** World-scoped media (delta J): narration from `alderforest` only. */
export const NARRATOR: CapabilityManifest = {
  kcb_version,
  identity: 'analyzer:agent:narrator',
  endpoints: { mcp: 'https://analyzer.example/mcp' },
  capabilities: [
    {
      name: 'narrate',
      inputs: [{ plane: 'knowledge', shape: 'prompt-text' }],
      outputs: [
        { plane: 'media', media_types: ['audio/wav'], world_pattern: 'alderforest' },
      ],
      cost: { tier: 'paid', est_units: 500 },
    },
  ],
};

/** A free renderer: MIDI to audio. The zero-cost route path search should prefer. */
export const RENDERER: CapabilityManifest = {
  kcb_version,
  identity: 'composer:agent:renderer',
  endpoints: { mcp: 'https://composer.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'local', est_units: 0 },
      endpoint: 'https://composer.example/mcp/render',
    },
  ],
};

/** The same hop, but paid — present so "cheapest wins" has something to beat. */
export const PREMIUM_RENDERER: CapabilityManifest = {
  kcb_version,
  identity: 'composer:agent:premium-renderer',
  endpoints: { mcp: 'https://premium.composer.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'paid', est_units: 900 },
    },
  ],
};

/** Entity in, knowledge out — the other cross-plane leg, and free. */
export const DESCRIBER: CapabilityManifest = {
  kcb_version,
  identity: 'pinakes:agent:describer',
  endpoints: { mcp: 'https://pinakes.example/mcp' },
  capabilities: [
    {
      name: 'describe',
      inputs: [{ plane: 'entity', types: ['mood', 'scene'] }],
      outputs: [{ plane: 'knowledge', shape: 'mood-descriptor' }],
      cost: { est_units: 0, unpriced: false },
    },
  ],
};

/** Ports but no named capability: discoverable and dialable, nothing to invoke. */
export const WORLD_EXPORT: CapabilityManifest = {
  kcb_version,
  identity: 'insimul:agent:world-export',
  endpoints: { a2a: 'https://insimul.example/.well-known/agent-card.json' },
  produces: [{ plane: 'knowledge', dialect: 'grounding-only', worlds: ['alderforest'] }],
};

/**
 * A caller's own **specialized** `finetune` provider (KFT §9, FT-K) — the stub the registry's
 * multi-provider tiebreak drives against. It advertises a deliberately NARROWER capability
 * than agora's general trainer: a single `modality` (`text-generation`), only its
 * neurosymbolic SLM methods, and — its data being synthetic/personal-tier — a `local-only`
 * tier. For a `text-generation` job both providers serve, the registry must prefer THIS one:
 * more specialized wins over the general trainer, before cost is even consulted (KCB §3).
 */
export const SPECIALIZED_FINETUNE: CapabilityManifest = {
  kcb_version,
  identity: 'pinakes:agent:finetune',
  endpoints: { a2a: 'https://pinakes.example/.well-known/agent-card.json' },
  consumes: [
    { plane: 'entity', types: ['model', 'text-generation'] },
    { plane: 'knowledge', dialect: 'grounding-only', shape: 'training-set' },
  ],
  produces: [
    { plane: 'entity', types: ['model', 'text-generation'] },
    { plane: 'media', media_types: ['application/vnd.koine.model+gguf'], world_pattern: '*' },
  ],
  capabilities: [
    {
      name: 'finetune',
      modality: 'text-generation',
      methods: ['sft', 'lora', 'qlora'],
      inputs: [
        { plane: 'entity', types: ['model', 'text-generation'] },
        { plane: 'knowledge', dialect: 'grounding-only', shape: 'training-set' },
      ],
      outputs: [
        { plane: 'entity', types: ['model', 'text-generation'] },
        {
          plane: 'media',
          media_types: ['application/vnd.koine.model+gguf'],
          world_pattern: '*',
        },
      ],
      // Cheaper per-run than the general trainer's text-generation rung (1_800_000), so the
      // "prefer specialized FIRST" rule is testable independent of cost — and cost still has
      // something to break when two providers are equally specialized.
      cost: { tier: 'local', meter: 'gpu-seconds', est_units: 900_000 },
    },
  ],
};

/** A capability its provider could not price — never the cheapest route (delta K). */
export const UNPRICED_RENDERER: CapabilityManifest = {
  kcb_version,
  identity: 'composer:agent:unpriced-renderer',
  endpoints: { mcp: 'https://unpriced.composer.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { est_units: 0, unpriced: true },
    },
  ],
};
