/**
 * The koine spec versions this build of the commons implements.
 *
 * Pinned here in TypeScript and again as `agora_provider_router.KCB_VERSION` in Python;
 * `provider-router/tests/test_skeleton.py` reads this file and asserts the two agree, which
 * is the only thing keeping the polyglot split honest. Bump both together.
 */
export const SPEC_VERSIONS = {
  /** Capability bus — `koine/specs/capability-bus.md` */
  kcb: '0.2.0',
  /** Identity / naming — `koine/specs/identity.md` */
  kinp: '0.2.0',
  /** Grounding packs — `koine/specs/grounding-pack.md` (governs the relation registry) */
  kgp: '0.4.0',
  /** Fine-tuning — `koine/specs/fine-tuning.md` (governs the finetune-job manifest) */
  kft: '0.3.0',
  /** Conformance-scenario format — `koine/specs/conformance-scenario.md` */
  kcs: '0.2.0',
} as const;
