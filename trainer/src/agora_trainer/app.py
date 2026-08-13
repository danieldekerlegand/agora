"""The trainer's HTTP surface — liveness, discovery, and the `finetune` task surface.

The trainer *publishes itself* so the registry can crawl it and peers can discover it, and it
serves the KCB §4 verbs a `finetune` caller actually dials: `invoke` admits a job and streams the
KFT §6 training-telemetry back to the caller that started the run, `subscribe` fans that same
stream out to every *other* consumer — an orchestrator watching a run it did not open, a console
attaching late, a client reconnecting after a dropped socket — and the run's §5 outputs outlive
its stream on two further surfaces: `exports` serves the §5.3 export matrix (the weight/export KMI
assets with their lineage and inherited envelope) and `register` registers the minted model entity
(§8) under the §5.4 output-egress rule. Every route here corresponds to an
endpoint the manifest advertises, and no manifest endpoint is unserved (ADR-0001 decision 3).

The config is built once from the process environment and cached; tests build their own
:class:`TrainerConfig` and override :func:`get_config`, so no test mutates global state.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import KCB_VERSION, KFT_VERSION, __version__
from .bridge import (
    Directory,
    Dispatch,
    http_dispatch,
    registry_directory,
    self_directory,
    submit,
)
from .config import TrainerConfig
from .engine import UnsupportedJob
from .grant import Grant
from .journal import RunJournal, RunRegistry
from .lineage import ArtifactBundle
from .manifest import (
    AGENT_CARD_PATH,
    EXPORTS_PATH,
    INVOKE_PATH,
    MANIFEST_PATH,
    REGISTER_PATH,
    SUBSCRIBE_PATH,
    agent_card,
    capability_manifest,
)
from .registration import RegistrationRejected, Registrations, register_bundle
from .runner import RunRejected, run
from .telemetry import TelemetryEvent
from .validate import Problem, Report, Status

app = FastAPI(title="agora trainer", version=__version__)

#: The §6 telemetry stream's content type — newline-delimited JSON, one event per line.
TELEMETRY_MEDIA_TYPE = "application/x-ndjson"

#: The KFT dataset bridge's producer-facing intake (§4.1) — where an application's thin adapter
#: (ADR-0008) offers its training exhaust as a by-reference dataset. Distinct from ``/invoke``:
#: that is this trainer answering as a *provider*, this is the commons admitting and routing.
BRIDGE_PATH = "/datasets"

#: The header carrying the `invoke:finetune` grant's gpu-seconds ceiling (KFT §7). Absent → an
#: ungated grant (signing the token is the caller's governance, US-6); a value gates spend.
BUDGET_HEADER = "X-Agora-Budget-Units"

#: The `subscribe` cursor: the first ``step`` a subscriber wants (KCB §4). A reconnecting
#: subscriber resumes from the step after its last seen event; re-reading a seen step is harmless
#: because the redelivered event carries the same content-addressed id (KFT §6).
FROM_STEP_QUERY = "from"

#: An explicit `finetune` target for the bridge's FT-K selection (KFT §8) — honored over the
#: specialized/cheaper tiebreak when that provider actually serves the job.
PROVIDER_HEADER = "X-Agora-Provider"

#: The admission verdict → HTTP status, the transport twin of the CLI exit codes
#: (0 ok / 1 invalid / 2 usage): a valid job streams (200), a schema/semantic failure is
#: unprocessable (422), and an unreadable request is a client usage error (400).
_HTTP_STATUS: dict[Status, int] = {
    Status.OK: 200,
    Status.INVALID: 422,
    Status.USAGE: 400,
}


@lru_cache(maxsize=1)
def get_config() -> TrainerConfig:
    """The process-wide config. Cached: it is an environment snapshot."""
    return TrainerConfig.from_env()


ConfigDep = Annotated[TrainerConfig, Depends(get_config)]


@lru_cache(maxsize=1)
def get_runs() -> RunRegistry:
    """The process-wide journal of live runs — what `subscribe` reads (KFT §6, KCB §4).

    Cached like the config: `invoke` writes a run's events into it and `subscribe` fans them out,
    so both verbs must see the same registry. A test (or a deployment backing the journal with a
    durable store) overrides it by identity.
    """
    return RunRegistry()


RunsDep = Annotated[RunRegistry, Depends(get_runs)]


@lru_cache(maxsize=1)
def get_registrations() -> Registrations:
    """The process-wide record of what this provider registered (KFT §8).

    Cached like the runs journal, and overridden by identity in a test: `register` writes an
    accepted registration here and the read verb serves it back, so both must see one ledger.
    """
    return Registrations()


RegistrationsDep = Annotated[Registrations, Depends(get_registrations)]


def get_directory(config: ConfigDep) -> Directory:
    """Which `finetune` providers exist — the registry when one is configured, else just us.

    A dependency rather than a module constant so a test (or a deployment wiring its own
    discovery) overrides it by identity, the same seam ``get_config`` uses.
    """
    if config.registry_url:
        return registry_directory(config.registry_url)
    return self_directory(config.identity, f"{config.base_url}{INVOKE_PATH}")


def get_dispatch() -> Dispatch:
    """How an admitted job reaches the selected provider — a direct `invoke` over HTTP."""
    return http_dispatch()


DirectoryDep = Annotated[Directory, Depends(get_directory)]
DispatchDep = Annotated[Dispatch, Depends(get_dispatch)]


@app.get("/health")
def health(config: ConfigDep) -> dict[str, str]:
    """Liveness + identity. Holds no secrets to leak."""
    return {
        "status": "ok",
        "identity": config.identity,
        "version": __version__,
        "kcb_version": KCB_VERSION,
        "kft_version": KFT_VERSION,
    }


@app.get(AGENT_CARD_PATH)
def a2a_agent_card(config: ConfigDep) -> dict[str, Any]:
    """The A2A agent card — the dialable address, pointing at the KCB manifest (KCB §3)."""
    return agent_card(config)


@app.get(MANIFEST_PATH)
def kcb_manifest(config: ConfigDep) -> dict[str, Any]:
    """The trainer's KCB capability manifest (KCB §2, KFT §2) — what the registry indexes."""
    return capability_manifest(config)


@app.post(INVOKE_PATH)
async def invoke(request: Request, runs: RunsDep) -> Response:
    """`invoke` the `finetune` capability (KCB §4) — admit the job, then stream §6 telemetry.

    Admission (KFT §3/§4.2/§7) runs first, over the full gate: an unreadable body is a usage
    error (400), and any admission failure — a schema/semantic reject (FT-F), an egress-gate or
    placement reject (§4.2/FT-J), or an over-ceiling spend reject (FT-E) — is unprocessable (422)
    with the structured report as the body, the HTTP twin of the validator's exit codes. The §7
    grant ceiling rides the ``X-Agora-Budget-Units`` header. A valid job is run and its
    training-telemetry stream (§6) is returned as newline-delimited JSON: one event per step in
    monotonic order, then the terminal event carrying the finetuned-model id + weight asset ids.
    A modality that is compatible but has no wired engine yet (US-4) is a distinct 501.

    Every emitted event is also written to the run's journal, so a consumer that did not open the
    run can `subscribe` to the identical ordered sequence (KCB §4) — this response is the caller's
    copy of the stream, not the only one.
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _reject(_usage_report("request body is not valid JSON"))
    try:
        events = run(payload, grant=_grant_from(request))
    except RunRejected as exc:
        return _reject(exc.report)
    except UnsupportedJob as exc:
        return JSONResponse(
            status_code=501,
            content={
                "ok": False,
                "status": "unsupported",
                "problems": [
                    Problem("no-engine", "/modality", str(exc)).describe(),
                ],
            },
        )

    job_id = str(payload["job"])
    journal = runs.open(job_id)

    def _ndjson() -> Iterator[bytes]:
        # `close` in a `finally`: a run that dies mid-stream — or a caller that disconnects —
        # must not leave its subscribers waiting on a step that will never be appended.
        try:
            for event in events:
                journal.append(event)
                yield _line(event)
        finally:
            journal.close()

    return _telemetry_response(_ndjson(), job_id)


@app.get(SUBSCRIBE_PATH)
def subscribe(
    runs: RunsDep,
    job: str,
    from_step: Annotated[int, Query(alias=FROM_STEP_QUERY, ge=0)] = 0,
) -> Response:
    """`subscribe` to a run's §6 training-telemetry (KCB §4) — the consumer's half of `invoke`.

    ``job`` names the run (its KINP activity id). The response is the same newline-delimited §6
    stream `invoke` returns: every recorded event from ``from`` onward in monotonic ``step``
    order, then the live tail as the run produces it, ending at the terminal event. Subscribing
    twice — or reconnecting with a cursor — redelivers events that carry the *same*
    content-addressed ``job + step`` ids, so a consumer deduplicates without an exactly-once
    transport (KFT §6).

    A ``job`` this process has never run is an honest ``404``: unlike a placeholder endpoint,
    there is genuinely no such run to stream (a deployment fronting several trainers routes the
    subscription to the one that owns the run).
    """
    journal = runs.get(job)
    if journal is None:
        return _unknown_run(job)

    def _ndjson() -> Iterator[bytes]:
        for event in journal.read(from_step=from_step):
            yield _line(event)

    return _telemetry_response(_ndjson(), job)


@app.get(EXPORTS_PATH)
def exports(runs: RunsDep, job: str) -> Response:
    """The §5.3 export matrix of a completed run — the KMI assets the run generated.

    ``job`` names the run. The body is the run's whole §5 output: the minted model entity (§5.1)
    with its base lineage, the §5.2 PROV activity it was anchored to, and one entry per weight /
    export asset — its byte-hash id, its registered ``application/vnd.koine.model+…`` media type,
    and the ``media:derived_from`` / ``media:variant_of`` link that makes the export matrix *the*
    KMI lineage graph rather than a bespoke export registry. Every entry also carries the egress
    class and union license it inherited from ``{data ∪ base}`` (§5.4), so the caller knows what
    it may `fetch` and where before it asks for a byte.

    A ``job`` this provider never ran is a ``404``; a run that has not reached its terminal event
    is a ``409`` — the matrix exists only once the run minted it (§5.2, FT-C), and an empty
    matrix would read as "this run produced nothing".
    """
    found = _completed(runs, job)
    if isinstance(found, JSONResponse):
        return found
    return JSONResponse(status_code=200, content={"ok": True, "job": job, **found.describe()})


@app.post(REGISTER_PATH)
async def register(request: Request, runs: RunsDep, registrations: RegistrationsDep) -> Response:
    """Register a completed run's minted model in the discovery registry (KFT §8, §5.4).

    A finetuned model is a KINP entity a capability can produce, so it belongs in the **KCB
    discovery registry** — the existing index, not a bespoke model store (§8). The body names the
    run (``{"job": …}``) and which side of the trust boundary it is being registered on
    (``across_boundary``, default in-tier), which is the one fact the provider cannot derive:
    whether the index is a cross-project / cloud one or the caller's own.

    The §5.4/FT-A output-egress rule is enforced here and reported, never silently applied: a
    model — or any weight/export asset — that inherited ``local-only`` from ``{data ∪ base}`` is
    **refused** a cross-boundary registration (``egress-output``, 422, the twin of the §4.2
    admission reject), while an in-tier registration admits any class, because keeping
    ``local-only`` output in-tier is exactly what §5.4 permits. ``201`` on a new registration,
    ``200`` when the identical entry already stood — re-registering a run is idempotent.
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _reject(_usage_report("request body is not valid JSON"))
    if not isinstance(payload, dict):
        return _reject(_usage_report("a registration request must be a JSON object"))
    job = payload.get("job")
    if not isinstance(job, str) or not job:
        return _reject(
            _usage_report("registration requires `job`, the id of a run this provider completed")
        )
    found = _completed(runs, job)
    if isinstance(found, JSONResponse):
        return found
    try:
        registered = register_bundle(found, across_boundary=bool(payload.get("across_boundary")))
    except RegistrationRejected as exc:
        return _reject(Report(status=Status.INVALID, problems=(exc.problem,)))
    stood = registrations.get(job)
    registrations.record(job, registered)
    return JSONResponse(
        status_code=200 if stood == registered else 201,
        content={"ok": True, "job": job, "registration": registered.describe()},
    )


@app.get(REGISTER_PATH)
def registration(registrations: RegistrationsDep, job: str) -> Response:
    """What this provider registered for ``job`` (KFT §8) — the index entry, read back.

    Registration is a state change, so it is answerable afterwards: an orchestrator that pushed a
    run's model asks whether it landed, and on which side of the boundary. A run whose model was
    never registered is a ``404`` — there is genuinely no entry, which is a different answer from
    "registered with nothing in it".
    """
    registered = registrations.get(job)
    if registered is None:
        return JSONResponse(
            status_code=404,
            content={
                "ok": False,
                "status": "unknown",
                "problems": [
                    Problem(
                        "unregistered",
                        "/job",
                        f"run {job!r} has no registered model on this provider; POST "
                        f"{REGISTER_PATH} to register a completed run's model (KFT §8)",
                    ).describe()
                ],
            },
        )
    return JSONResponse(
        status_code=200, content={"ok": True, "job": job, "registration": registered.describe()}
    )


def _completed(runs: RunRegistry, job: str) -> ArtifactBundle | JSONResponse:
    """``job``'s minted §5 artifact bundle, or the structured refusal that stands in for it.

    The bundle rides the run's terminal telemetry event out of band from the id-only §6 wire
    shape, and the journal retains it — so the outputs of a run stay readable after its stream
    ended, which is what makes `exports` and `register` addressable at all.
    """
    journal = runs.get(job)
    if journal is None:
        return _unknown_run(job)
    bundle = _minted(journal)
    if bundle is None:
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "status": "incomplete",
                "problems": [
                    Problem(
                        "run-incomplete",
                        "/job",
                        f"run {job!r} has not reached its terminal event; a run's §5 outputs are "
                        "minted at completion (KFT §5.2, FT-C), so there is nothing to serve yet",
                    ).describe()
                ],
            },
        )
    return bundle


def _minted(journal: RunJournal) -> ArtifactBundle | None:
    """The artifact bundle on a run's terminal event, or ``None`` while the run is unfinished."""
    for event in reversed(journal.replay()):
        if event.terminal and event.artifacts is not None:
            return event.artifacts
    return None


def _unknown_run(job: str) -> JSONResponse:
    """A run this process never `invoke`d — an honest 404 rather than an empty success."""
    return JSONResponse(
        status_code=404,
        content={
            "ok": False,
            "status": "unknown",
            "problems": [
                Problem(
                    "unknown-run",
                    "/job",
                    f"no run {job!r} on this provider; the `subscribe` / `exports` / `register` "
                    "verbs answer for a run this trainer `invoke`d (KFT §6/§5.3/§8, KCB §4)",
                ).describe()
            ],
        },
    )


def _line(event: TelemetryEvent) -> bytes:
    """One §6 event on the wire — a JSON object per line (id-only shape, `describe`)."""
    return (json.dumps(event.describe()) + "\n").encode("utf-8")


def _telemetry_response(events: Iterator[bytes], job: str) -> StreamingResponse:
    """The §6 stream as a response — identical for `invoke` and `subscribe` by contract."""
    return StreamingResponse(
        events,
        media_type=TELEMETRY_MEDIA_TYPE,
        headers={"X-Agora-Job": job},
    )


@app.post(BRIDGE_PATH)
async def datasets(request: Request, directory: DirectoryDep, dispatch: DispatchDep) -> Response:
    """The KFT dataset bridge (§4.1) — a producer offers its training exhaust *by reference*.

    The producer-facing half of the training plane: the body is a finetune job manifest whose
    ``dataset`` names KGP packs, KMI assets and its own ``records[]`` files, each described by an
    inline ``dataset-jsonl-header``. The bridge runs the whole §4 gate over those descriptions —
    **before any byte moves** — then asks the registry which `finetune` provider gets the job
    (§8/FT-K) and dials that provider directly (ADR-0001 decision 3).

    ``202`` when the job was admitted and dispatched (the run itself streams from the *provider*,
    which may be this trainer or a peer); ``422`` with the graded report when the corpus, the
    egress envelope, the license union, the spend ceiling or the provider selection refused it;
    ``400`` when the body is not readable as a job at all. ``X-Agora-Provider`` names an explicit
    target (KFT §8) — a header rather than a job field, since the ratified job schema closes the
    manifest and carries no such property.
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _reject(_usage_report("request body is not valid JSON"))
    if not isinstance(payload, dict):
        return _reject(_usage_report("a finetune job must be a JSON object"))
    result = submit(
        payload,
        grant=_grant_from(request),
        directory=directory,
        dispatch=dispatch,
        provider=request.headers.get(PROVIDER_HEADER),
    )
    status = 202 if result.ok else _HTTP_STATUS[result.report.status]
    return JSONResponse(status_code=status, content=result.describe())


def _grant_from(request: Request) -> Grant:
    """Build the §7 grant from the ``X-Agora-Budget-Units`` header — absent/unparseable → ungated.

    A real grant is a signed ``invoke:finetune`` token (KCB §5, US-6); until that lands the header
    carries just its load-bearing field, the ``budget_units`` ceiling.
    """
    raw = request.headers.get(BUDGET_HEADER)
    if raw is None:
        return Grant()
    try:
        return Grant(budget_units=float(raw))
    except ValueError:
        return Grant()


def _reject(report: Report) -> JSONResponse:
    """Render an admission rejection at the mapped HTTP status (KFT §3.1)."""
    return JSONResponse(status_code=_HTTP_STATUS[report.status], content=report.describe())


def _usage_report(message: str) -> Report:
    return Report(status=Status.USAGE, problems=(Problem("usage", "/", message),))
