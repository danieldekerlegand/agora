/**
 * The koine spec versions this build of the commons implements.
 *
 * ## Where the pins live
 *
 * Read off koine's own spec headers (`../koine/specs/<spec>.md`, the `**Spec version:**` line) —
 * never from memory and never from another agora file, because the pins exist in FOUR languages:
 * here; as `agora_provider_router.KCB_VERSION` and `agora_trainer.KCB_VERSION` + `KFT_VERSION` in
 * Python; as `apr:kcb_version/0` in Erlang; and as `KMI_VERSION` in `translation-core` (Rust).
 * `provider-router/tests/test_skeleton.py`, `trainer/tests/test_skeleton.py` and
 * `apr_conformance_SUITE` read this file and assert the others agree with it — that keeps the
 * polyglot split honest, but only against ITSELF. Bump them all together, and take each value from
 * koine's header when you do.
 *
 * What compares this table to KOINE is the drift gate, `conformance/koine-pin-drift.ts`: it reads
 * the `**Spec version:**` header out of each spec named in the register below and fails the schemas
 * gate when a row disagrees (loudly SKIPPED, never silently passed, where no koine sibling is
 * checked out). So a row that lags koine has to be a deliberate entry in that register — it can no
 * longer be an oversight nobody notices.
 *
 * ## The policy — TRACK-CURRENT, ratified or candidate alike
 *
 * Every row below names the version in koine's spec header **today**, whatever that spec's status
 * is. Four of the six are **Candidate**; they are pinned exactly as the two **Ratified** ones are.
 * The rule is uniform on purpose — a mixed table (one row current, another held at its last
 * ratified version) states no rule at all, so nobody can tell a decision from an oversight.
 *
 * Why track-current rather than hold-at-ratified, or pin-forward-only-when-additive:
 *
 * 1. **koine publishes exactly one text per spec.** There is no archive of superseded versions, so
 *    a pin to a last-ratified version names a document no reader can retrieve. The pin would stop
 *    meaning *what this build implements* and start meaning *what it once implemented*. koine
 *    states the same rule for its own cross-spec pins (`fine-tuning.md`'s header, "track-current,
 *    `MAJOR.MINOR.x`") — agora's pins on koine follow koine's pins on koine.
 * 2. **The commons is what candidacy is waiting on.** Each candidate spec's status note names its
 *    re-ratification path, and those paths are runtime work — scenario re-runs against the new
 *    shape (KCB §2's AgentCard extension, KMI §4's OTIO model). A commons that waits for
 *    ratification blocks the ratification that waits on the commons.
 * 3. **Candidate here means "not yet re-validated", not "unstable draft".** The status notes name
 *    what re-opened validation and what closes it, so the risk a candidate pin carries is bounded
 *    and legible rather than open-ended.
 *
 * The cost, stated rather than wished away: a candidate spec can still move, and each move costs a
 * lockstep bump across four languages plus every fixture that stamps the version. That is accepted
 * deliberately — and the drift gate that reads koine's own headers is what makes that cost land on
 * the next `make check` rather than at the next audit.
 *
 * What track-current does **not** mean:
 *
 * - **It is not a claim to a shape this build has not implemented.** A pin says *this build
 *   implements that text*. When a revision requires a shape change agora has not made, the row
 *   advances only if the spec's own transition clause keeps the old shape conformant meanwhile;
 *   otherwise the row holds and records the reason + the condition that moves it (see the register
 *   below — that is what a deliberate lag looks like, and there is currently one).
 * - **It is not auto-following a MAJOR.** A major is breaking by definition, so it lands as its own
 *   change alongside the shape work, never as an edit to this table.
 *
 * ## The tolerance — where a version difference is already forgiven, and where it is not
 *
 * The pins are not all enforced the same way, so "the pin moved" costs different things per row:
 *
 * - **Majors only (forgiving).** KGP pack ingest — `resolver/src/grounding.ts` reads the §2
 *   envelope and refuses only a different *major*, because that module's envelope + §4.2 link
 *   relations are unchanged across 0.x minors. A conformant producer that moved to koine's newest
 *   KGP before agora did is admitted either way; the pin advance changes what agora *emits*
 *   (`knowledge/src/pack.ts`), not what it accepts.
 * - **Major AND minor (strict, pre-1.0).** KCB manifests at the index (`isCompatibleKcbVersion`,
 *   `manifest.ts`) and KCS scenarios (`isCompatibleKcsVersion`, `scenario.ts`) refuse a different
 *   minor below 1.0, pre-1.0 minors being breaking by convention. Advancing either row therefore
 *   makes every fixture still declaring the old minor unreadable — so a KCB/KCS bump moves its
 *   fixtures and sample manifests in the SAME change or the gates go red. The relation registry's
 *   own `registryVersion` follows the same rule (`isCompatibleRegistryVersion`) but is versioned by
 *   koine's registry data, not by this table.
 * - **No predicate at all.** KINP, KMI and KFT have no compatibility check in this build: KINP is
 *   reported in `resolver` health, KMI is stamped onto emitted OTIO metadata (`translation/`), and
 *   KFT is stamped on a finetune job — where `trainer` echoes the caller's `kft_version` when it
 *   sent one. For these three the pin is a statement of what agora emits, so a moved row changes
 *   bytes rather than admissions, and Studio reports a peer's mismatch as UNJUDGED
 *   (`studio/src/checks.ts`) — the honest verdict when `@agora/schemas` states no rule to judge by.
 *
 * ## Per-row register — status, and any deliberate deviation with the condition that ends it
 *
 * | Row | koine status | Tracks koine's current version | Note |
 * |---|---|---|---|
 * | **KCB** | Candidate | yes | One deliberate implementation lag, recorded so it is not mistaken for an oversight: agora still emits the *legacy* manifest-extension namespace root (`koine.dev/kcb/manifest/0.3`) where KCB §2.3b requires the `w3id.org` root of a producer. The *pin* is not what lags — the emitted string is, and moving it means re-emitting a byte-for-byte conformance corpus, not editing it. Condition that ends it: `chief/72-kcb-extension-uri-migration` lands (itself waiting on `koine:75`). Deadline: **KCB 0.6.0** removes the legacy form (§2.3e), after which this row could not honestly stay current. |
 * | **KINP** | Ratified | yes | Nothing outstanding. |
 * | **KGP** | Candidate | yes | The majors-only ingest above means this row's advance was never load-bearing for admission — it is load-bearing for what `knowledge/` emits. |
 * | **KMI** | Candidate | yes | Watch KMI **0.4.0**: it *removes* `application/vnd.koine.edl+json` (§4.4), so that bump is a deletion rather than an addition — `translation/` drops the EDL path in the same change or the row must hold with the reason recorded here. |
 * | **KFT** | Candidate | yes | KFT's own header pins the five planes it composes track-current too, so this row moving is normally downstream of the others moving. |
 * | **KCS** | Ratified | yes | Strict minor rule above: the scenario library moves with it. |
 *
 * A row that ever stops tracking koine writes its reason and its ending condition into this table
 * in the same change that holds it — a lag with no entry here is a bug, and the drift gate reports
 * it as one.
 */
export const SPEC_VERSIONS = {
  /** Capability bus — `koine/specs/capability-bus.md` (Candidate) */
  kcb: '0.4.3',
  /** Identity / naming — `koine/specs/identity.md` (Ratified) */
  kinp: '0.2.1',
  /** Grounding packs — `koine/specs/grounding-pack.md` (Candidate; governs the relation registry) */
  kgp: '0.5.2',
  /** Media interchange — `koine/specs/media-interchange.md` (Candidate; governs `translation/`, the OTIO engine) */
  kmi: '0.3.2',
  /** Fine-tuning — `koine/specs/fine-tuning.md` (Candidate; governs the finetune-job manifest) */
  kft: '0.5.0',
  /** Conformance-scenario format — `koine/specs/conformance-scenario.md` (Ratified) */
  kcs: '0.2.0',
} as const;
