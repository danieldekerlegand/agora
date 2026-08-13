# trainer

agora's **general finetune trainer** — the runtime implementation of the koine fine-tuning
profile (KFT, `../../koine/specs/fine-tuning.md`). One leaf capability on the KCB bus: it
consumes training data (KGP knowledge / KMI media) plus a base-model entity (KINP) and produces
a new model entity (KINP) plus weight assets (KMI), advertised as the `finetune` capability
(KCB §2, KFT §2).

**Distinct from the provider-router, never merged** (ADR-0001 decision 1). The provider-router
routes *inference* to model backends; the trainer runs long-lived, stateful, GPU *fine-tuning*
jobs. They share the bus, not a process — this package imports nothing from
`agora_provider_router`.

## What it advertises (US-1)

One `finetune` capability per KFT §3.1 modality (`text-generation`, `image-text-to-text`,
`video-text-to-text`, `text-to-image`, `text-to-video`), each with plane-typed ports:

- **in** — a `model`/entity base-model port + a `knowledge` and/or `media` training-set port,
- **out** — a `model`/entity finetuned-model port + a `media` weights port
  (`application/vnd.koine.model+safetensors` / `+gguf`, KFT §5.3),
- **cost** — metered in `gpu-seconds` (KFT §2/§7); the static figure is nominal, the real gate is
  the admission-time per-job estimate (FT-E, US-3).

The modality rides the entity ports' `types` (the §5.1 model-entity refinement), so the registry
finds the trainer both by capability name `finetune` and by modality.

## Admission, engines & telemetry (US-2)

`invoke` (`POST /invoke`, KCB §4) admits a finetune job, then streams the KFT §6
training-telemetry over the same request:

- **Admission** validates the payload against the vendored `finetune-job.schema.json` (KFT §3;
  the copy under `src/agora_trainer/schemas/` is pinned byte-for-byte to koine) and then checks
  the `modality × method` combination (KFT §3.1, FT-F) — an incompatible pair (e.g.
  `dpo × text-to-image`) is rejected *before* any engine runs. The verdict is a structured report
  with exit-code semantics matching agora's validators: **0** ok / **1** invalid / **2** usage —
  over the CLI (`agora-trainer-validate <job.json>`) and mirrored to HTTP (200 / 422 / 400).
- **Engine ladder** (KFT §9): an admitted job is dispatched by `modality × method` to an engine
  adapter (`prepare_data → launch → emit_telemetry → export`). US-2 wires the **LLaMA-Factory**
  rung (`text-generation` × {sft, lora, qlora}); a compatible-but-unwired modality (e.g.
  `text-to-image`, US-4's diffusers rung) is an honest `501`, distinct from a rejection.
- **Telemetry** (KFT §6): one event per training step in monotonic order, content-addressed by
  `job + step` so redelivery is idempotent, closed by a terminal event carrying the minted
  finetuned-model id + weight/export asset ids. Where no GPU / LLaMA-Factory is present the
  adapter replays a **recorded run** (real per-step logs), never a fabricated loss curve.

### `subscribe` — the same stream, for consumers that did not open the run (agora:50 US-1)

`invoke` hands the §6 stream back to *the connection that started the run*, which is the wrong
shape for a consumer that isn't that connection: KFT §6 says a consumer **`subscribe`s** (KCB §4),
and the orchestrator issuing a job, a console watching it, and a client reconnecting after a
dropped socket are three different readers of one run. `GET /subscribe?job=<activity-id>` is that
verb, and it is advertised in the manifest (`endpoints.subscribe`) because it is served:

- every event `invoke` emits is written to the run's **journal** (`src/agora_trainer/journal.py`),
  so a subscriber receives the ordered sequence from step 0 — or from `&from=<step>` — through
  the terminal event, replaying what already happened and then blocking for the live tail;
- **redelivery is idempotent by construction**: the journal mints nothing, so a second subscriber
  (or a reconnect at a cursor) reads the *same* events with the same content-addressed `job + step`
  ids — which is what lets the stream skip an exactly-once transport (KFT §6, KCB §4);
- a run that dies without a terminal event **closes** its journal rather than stranding readers,
  and a `job` this process never ran is an honest `404` (there is no such run to stream), not an
  empty 200.

Retention is an in-memory, bounded read model — a provider-local fan-out, not a durable event
store; eviction only ever drops *closed* runs, so a live run is never yanked from its subscribers.
A deployment that must survive a restart backs the same interface with a persistent log.

### `exports` + `register` — a run's §5 outputs outlive its stream (agora:50 US-2)

A run's stream ends; its outputs do not. Two further verbs answer for a completed run, both
advertised (`endpoints.exports`, `endpoints.register`) because both are served:

- **`GET /exports?job=<activity-id>`** — the **§5.3 export matrix**: the minted model entity with
  its `based_on`/`derived_from` links (§5.1), the §5.2 PROV activity that anchors it (`used` /
  `generated` / `seed` / `config_hash`), and one entry per weight/export asset carrying its
  byte-hash id, its registered `application/vnd.koine.model+…` media type, and its
  `media:derived_from` (adapter → base) / `media:variant_of` (each export → the adapter) link.
  The matrix **is** the KMI lineage graph — there is no bespoke export registry — and every entry
  also carries the egress class + union license it inherited from `{data ∪ base}` (§5.4), so a
  consumer knows what it may `fetch`, and where, before asking for a byte.
- **`POST /register`** `{"job": …, "across_boundary": false}` — the **§8 registration** of the
  minted model entity. A finetuned model is a KINP entity a capability can produce, so it belongs
  in the existing **KCB discovery registry**, not a bespoke model store; that is what makes a
  finetuned model composable (§8). `across_boundary` is the one fact the provider cannot derive —
  whether the index is a cross-project / cloud one or the caller's own. `GET /register?job=…`
  reads the entry back, because registration is a state change and an orchestrator asks whether
  its run's model landed.

**Output egress is enforced here** (§5.4/FT-A, `registration.py`): a model — or any weight/export
asset — that inherited `local-only` from `{data ∪ base}` is **refused** a cross-boundary
registration with a reported `egress-output` problem (`422`, the twin of the §4.2 admission
reject), while an in-tier registration admits any class, because keeping `local-only` output
in-tier is exactly what §5.4 permits. Both verbs share the run journal's terminal event, where the
full artifact bundle rides out of band from the id-only §6 wire shape — so what §6 announced,
§5.3 serves and §8 indexes, with one minting authority (`lineage.py`) and no second projection.
A run this process never `invoke`d is a `404`; one that has not reached its terminal event is a
`409` (the §5 outputs are minted at completion, FT-C), never an empty matrix.

### The four-verb dance — the client that proves those endpoints (agora:50 US-3)

An endpoint is only *live* if something reaches it knowing nothing but one address. `tests/`
carries that caller: `finetune_client.py`, a **test-scoped** KCB `finetune` client
(`tests/test_finetune_client.py` drives it), which runs the dance a real consumer runs —

1. **discover** — handed only the A2A agent card, it reads the KCB manifest, then the *capability's
   own* `endpoint` for the job's modality and the `subscribe` / `exports` / `register` addresses
   out of what the provider published (KCB §3). No route is a constant, so the test fails if the
   manifest and the served surface ever drift apart;
2. **subscribe** — it starts watching the job id **before** dispatching it and tolerates the honest
   `unknown-run` 404 until the run opens. That is the orchestrator's real ordering, and it is what
   makes the retry — not a lucky race — the thing under test: the §6 stream is addressable *by
   job*, not merely readable on the invoking connection;
3. **invoke** — a schema-valid job, carrying an `invoke:finetune` grant (KCB §5) whose
   `budget_units` ceiling rides `X-Agora-Budget-Units` on this verb *only* (it is the verb that
   spends); a starved ceiling is refused before the run starts (FT-E) with the provider's own
   report, and the subscriber is released rather than stranded;
4. **collect** — the §5.3 matrix and, when the caller says which side of the boundary it is
   indexing on, the §8 registration — where a `local-only`-inheriting model is refused
   `across_boundary` (`egress-output`, §5.4/FT-A) and admitted in-tier.

The two copies of the stream — the invoking connection's and the subscriber's — are asserted
**identical**, monotonic, and uniquely content-addressed, which is the §6 idempotency claim
stated as a test rather than a docstring.

It stays in `tests/` by decision: agora publishes the capability, and the client that consumes it
belongs to whoever runs the control plane (ADR-0001). The production client is another repo's —
recorded in the table under [Scope boundary](#scope-boundary--what-is-not-built-here) — and this
is the agora-side stand-in that keeps these endpoints honest between deployments.

## Egress-gated placement & spend gating (US-3)

Admission does more than check the payload — before any compute is committed it computes the
NORMATIVE KFT §4.2 egress gate and the §7 spend ceiling over the job's *resolved* inputs:

- **Effective egress** (§4.2, FT-B) is the *most-restrictive* class across `{all training data
  records/assets ∪ the base-model entity}`. One `local-only` input — data **or** base — pins the
  whole run `local-only`. `compute.egress` steers it: `derived` uses the computed class,
  `local-only` pins, and `exportable` is an *assertion* the provider verifies against the data and
  rejects on violation (an `egress-assertion` reject) — never honored blindly.
- **SkyPilot placement** is then contract-governed, not an operator setting. A `local-only` run
  MUST stay on local / in-tier compute; naming a cross-boundary `compute.class` (a rented/cloud
  GPU) is **rejected** (`egress-cross-boundary`), never silently downgraded. An all-`exportable`
  corpus MAY burst to a cloud GPU of the requested class. A `local-only` job the local tier
  **cannot run** (e.g. video-diffusion on an under-provisioned tier) is a **rejection at
  admission** (`egress-unsatisfiable`, FT-J) — never a hang, never a silent cloud placement.
- **Spend ceiling** (§7, FT-E): the static `cost.est_units` can't gate a variable-size job, so the
  trainer computes a per-job `gpu-seconds` estimate **after** resolving dataset cardinality
  (fetching KMI/KGP metadata as needed — the offline stand-in resolves nominal facts, a deployment
  injects the real `fetch:asset` path) and rejects a run whose estimate exceeds the grant's
  `budget_units` (`budget`) **before** provisioning. The ceiling rides the `X-Agora-Budget-Units`
  header on `invoke` (signing the `invoke:finetune` grant token is the caller's governance, US-6).

Every rejection is the same structured report + exit-code semantics as US-2 (0 / 1 / 2 over the
CLI, 200 / 422 / 400 over HTTP).

## Multimodal adapter + artifacts with lineage & inheritance (US-4)

The engine ladder gains its media-plane rung and the run gains its full KFT §5 output:

- **diffusers rung** (`src/agora_trainer/diffusers.py`): diffusers + ai-toolkit / SimpleTuner for
  `text-to-image` ({lora, full}) and `text-to-video` ({lora}); the **LLaMA-Factory** rung now also
  covers the VLM modalities `image-text-to-text` / `video-text-to-text`. Every modality is wired —
  a compatible-but-unwired 501 is now unreachable via a schema-valid job.
- **Paired samples ride the records, not the arrays** (`pairing.py`, FT-I): the image↔caption join
  is read from the dataset-jsonl-header **training records** (a KMI `asset` id + its `text` per
  row), never `dataset.knowledge[]`/`dataset.media[]` (those are the fetch/egress manifest). Media
  assets are `fetch`ed lazily via the KMI `fetch:asset` seam (KMI §7) — an injected, offline
  stand-in here, the real grant-scoped fetch in a deployment.
- **Artifacts, lineage & inheritance** (`lineage.py`): on completion the run mints the finetuned
  model as a KINP `model` entity with a **minted** (not content-addressed) id anchored to the run
  (§5.2, FT-C), a PROV activity carrying `used`/`generated` + `seed` + `config_hash`, and
  `based_on`/`derived_from` links to the base (§5.1, FT-G); a re-train links via
  `retrains`/`supersedes`. Weights + each requested export are KMI assets whose media types and
  `media:derived_from`/`media:variant_of` lineage *are* the §5.3 export matrix. The model entity
  **and every weight asset** inherit the most-restrictive egress + union license of `{data ∪ base}`
  (§5.4, FT-A). The bundle rides the terminal telemetry event out of band from the id-only §6 wire.
- **Output-egress enforcement at registration** (`registration.py`, §5.4/FT-A): a
  `local-only`-inheriting model is **refused** a cross-boundary registration and reported
  (`egress-output`) — the model-artifact twin of `schemas/axes.ts::assertPackEgress`, and the
  trainer-side stand-in for the discovery registry's (§8) refusal. An in-tier registration admits
  any class — `local-only` output stays in-tier, which is exactly what §5.4 permits.

## Multi-provider routing + scope boundary (US-5)

Training is **multi-provider** (KFT §9, FT-K): agora hosts the **general** `finetune` provider,
a participant may run its **own specialized** one, and more than one can match a job (both accept
`text-generation`). The **discovery registry** — not the trainer — disambiguates
(`registry/src/select.ts`, `CapabilityRegistry.selectFinetune`): it prefers the more **specialized**
matching provider (the narrower advertised `modality × method` surface), then lower `cost` (KCB §3);
a job MAY name a target provider explicitly (honored, but rejected if it can't serve the job); an
**unbroken tie** (equal specialization *and* cost) is **surfaced to the caller**, never resolved by
registration order. The trainer's manifest advertises only the **general** modalities/methods it
serves, which is exactly what lets the registry tell it apart from a narrower specialist (the stub
`SPECIALIZED_FINETUNE` manifest drives the tiebreak test).

### Scope boundary — what is NOT built here

agora hosts **only the general** provider: a **specialized** provider is its own repo's work,
advertised as a distinct capability on the bus, never an adapter in here. Per ADR-0001 (koine
specifies, agora implements) and the multi-provider decision (FT-K), those follow-ups are handed to
the participants' own repos and run under their own gates.

**`agora:41-finetune-job-validator` is delivered** — it was the one row here naming *this* repo,
and it is now the `finetune-job` entry in the Makefile's `ARTIFACTS` set: the KFT §3 job manifest
rides the same two-validator conformance smoke as every other interchange artifact (ajv over
`schemas/src/validate.ts`, jsonschema over `agora_provider_router.artifact_validator`), under
`make check` via `check-conformance`. It is **structural admission only** — schema conformance,
0 ok / 1 invalid / 2 usage, no policy. Every semantic judgement described above stays exactly where
it is: `modality × method` (§3.1/FT-F), the §4.2 egress gate and placement (FT-B/FT-J) and the §7
spend ceiling (FT-E) are **this provider's** admission, and a specialized provider's are its own
repo's. The full split is tabulated in `schemas/README.md`
§"Structural validation only — where semantic admission lives".

The table below is a **historical record** of how that boundary fell for the ecosystem agora was
extracted from — named there because koine's program map (`../koine/tasks/chief/README.md`,
Tranche D) is where the live version lives, not because agora knows these callers:

| Follow-up | Repo | Role | Outcome |
|---|---|---|---|
| `30-kft-provider-manifest` | a participant's model repo (`lugh`) | That participant's own **specialized** `finetune` provider — its local TRL+PEFT (SLM + Mac-MPS) path published as a **distinct capability on the bus**, NOT an adapter inside agora; inherently `local-only`. | **Merged.** It landed there rather than in the repo the row originally named (`pinakes:90-finetune-provider` was never authored; the retarget is recorded in that ecosystem's own `102-retarget-finetune-provider-to-lugh`). |
| `90-finetune-client` | that ecosystem's **orchestrator** (`cuneiform`) | The KCB **client** replacing the stub runner — discover → invoke → **subscribe** to the real §6 stream, reading export (§5.3) and registering (§8), issuing `invoke:finetune` grants (§7). | **Merged** (`Runner::Kcb` replaced `Runner::Stub`). It dials the specialized provider above **and** this trainer at runtime, letting the registry disambiguate (FT-K). `tests/test_finetune_client.py` is the agora-side stand-in for it. |

## The KFT dataset bridge — a producer's training exhaust, by reference (`40:US-2`)

`POST /datasets` is the **producer-facing** intake, the sibling of `knowledge/`'s KGP bridge on the
training plane. An ordinary application emits *training exhaust* — accepted NL edits, generations,
preference pairs, QA labels — through a thin adapter (koine ADR-0008); the bridge is the generic
commons path that turns it into an admitted, routed finetune run. Nothing here canonicalizes
anybody's records: what arrives is already a by-reference KFT dataset or it is refused.

**By reference, never inlined** (§4.1, FT-M). A record file is a **KMI asset** carrying
`application/vnd.koine.dataset+jsonl`, referenced from `dataset.records[]`. The trainer's manifest
advertises a `training-records` port for it on every modality, so path search routes it there
rather than mis-routing a JSONL at the image/video port.

**The gate runs before a byte moves.** Each `records[]` entry carries its `dataset-jsonl-header`
inline, positionally (FT-O), and that is what admission reads:

| Check | Clause | Refusal |
|---|---|---|
| one header per referenced file | FT-O | `header-missing` / `header-orphan` |
| egress read from the header, **never** inferred from `tier` | FT-N | `header-egress` |
| a declared license class (the §5.4 union the output inherits) | §4.3 | `license-missing` / `license-refused` |
| no rows smuggled into the manifest | §4.1 | `records-inlined` |
| `recordCount` sizes the spend estimate | FT-P | `budget` |
| the inline header is verified against the file on fetch | §4.1 | `header-mismatch` / `record-count-overrun` |

The trust tier stays **descriptive** — a `personal` corpus its owner is happy to publish is not
pinned, and a `curated` corpus that must not leave is not green-lit. That is FT-N, and it is why
the header carries the class explicitly.

**Routing is the registry's call, dialing is the bridge's** (§8/FT-K). The bridge does not
re-implement the specialized-then-cheaper precedence — it asks `POST /finetune/select` and reads
the verdict, so agora has exactly one implementation of FT-K. It then applies the one rule the
registry cannot: a `local-only` run may not be handed to a provider outside the originating trust
boundary (`provider-egress`) — shipping the job out is the same breach as renting it a cloud GPU.
The winner's address is dialed **directly** (ADR-0001 decision 3); an unbroken tie is surfaced
(`provider-tie`), never settled here.

Point `AGORA_TRAINER_REGISTRY_URL` at a registry to get the real multi-provider selection; unset,
this trainer is its own sole candidate. `X-Agora-Provider` names an explicit target (a header, not
a job field — the ratified job schema closes the manifest). The captured registry verdicts in
`registry/src/fixtures/finetune-selection.json` are a **cross-language pin**: `select.test.ts`
asserts the registry still produces them, `tests/test_registry_selection.py` that the bridge still
reads them. Regenerate with
`AGORA_CAPTURE=1 npx vite-node registry/src/fixtures/generate-finetune-selection.ts`.

## Run it

Standalone — no repo-root Makefile, no sibling areas. Install the package and launch the console
entry point (or the module runner); both boot the FastAPI app under uvicorn, reading
`AGORA_TRAINER_HOST` (default `0.0.0.0`) and `AGORA_TRAINER_PORT` (default `8001`, one above the
provider-router's) from the environment:

```sh
pip install agora-trainer            # or: uv pip install agora-trainer
agora-trainer                        # the [project.scripts] console entry point
# equivalently:
python -m agora_trainer
```

It serves `/health`, the A2A agent card at `/.well-known/agent-card.json`, the KCB manifest at
`/.well-known/kcb-manifest.json`, and the `finetune` task surface at `/invoke` — exactly the
endpoints the manifest advertises, and only those (ADR-0001 decision 3). `POST /datasets` is the
producer-facing dataset bridge above; it is a *caller* of `/invoke`, not an advertised capability
endpoint of its own.

## Gate

```sh
make check-trainer    # ruff check + ruff format --check + mypy --strict + pytest
```
