/**
 * The koine spec versions this build of the commons implements.
 *
 * Read off koine's own spec headers (`../koine/specs/<spec>.md`, the `**Spec version:**` line) —
 * never from memory and never from another agora file, because the pins exist in THREE languages:
 * here, as `agora_provider_router.KCB_VERSION` / `agora_trainer.KCB_VERSION` + `KFT_VERSION` in
 * Python, and as `apr:kcb_version/0` in Erlang. `provider-router/tests/test_skeleton.py`,
 * `trainer/tests/test_skeleton.py` and `apr_conformance_SUITE` read this file and assert the
 * others agree with it — that keeps the polyglot split honest, but only against ITSELF. Bump them
 * all together, and take each value from koine's header when you do.
 */
export const SPEC_VERSIONS = {
  /** Capability bus — `koine/specs/capability-bus.md` */
  kcb: '0.4.3',
  /** Identity / naming — `koine/specs/identity.md` */
  kinp: '0.2.1',
  /** Grounding packs — `koine/specs/grounding-pack.md` (governs the relation registry) */
  kgp: '0.5.2',
  /** Media interchange — `koine/specs/media-interchange.md` (governs `translation/`, the OTIO engine) */
  kmi: '0.3.2',
  /** Fine-tuning — `koine/specs/fine-tuning.md` (governs the finetune-job manifest) */
  kft: '0.5.0',
  /** Conformance-scenario format — `koine/specs/conformance-scenario.md` */
  kcs: '0.2.0',
} as const;
