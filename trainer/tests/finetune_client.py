"""A KCB `finetune` client — the four-verb dance, dialed against the live endpoints.

The trainer's surfaces only earn the word *live* once something dials them the way a real caller
does: discover the provider from its A2A card, carry an `invoke:finetune` grant with a KFT §7
ceiling, invoke a schema-valid job, and `subscribe` to that run's §6 telemetry through the
terminal event — then read what the run minted (§5.3) and register it (§8). This module is that
caller, and it is deliberately **test-scoped**: agora publishes the capability, not the client
that consumes it, so this is the standing proof that the endpoints answer, never a shipped SDK.

*Attributed cross-repo reference* — history, not something agora knows, and named nowhere in
`src/` (a participant is whatever publishes a KCB manifest): the production version of this
client belongs to the control-plane orchestrator (`cuneiform:90-finetune-client`, merged — its
`Runner::Kcb` replaced the stub runner), and at deploy time it drives this same dance against
*both* a participant's **specialized** provider (`lugh:30-kft-provider-manifest`) and this
general trainer, letting the discovery registry disambiguate the two (KFT §9/FT-K,
`registry/src/select.ts`). What stands here is the agora-side stand-in for it.

Three choices keep this a client rather than a convenience wrapper over known routes:

* **Everything is discovered.** The client is handed exactly one address — the A2A agent card —
  and reads the manifest from it, then the capability's *own* `invoke` endpoint for the job's
  modality and the `subscribe` / `exports` / `register` addresses out of what the provider
  publishes (KCB §3). A hardcoded ``/invoke`` would prove the route works but not the manifest.
* **Subscribe before you invoke.** :meth:`FinetuneClient.finetune` starts watching the job id
  *before* dispatching it, and tolerates the honest `404` the provider returns for a run it has
  not opened yet. That is the orchestrator's real ordering — it mints the job id, watches it,
  then dispatches — and it is exactly why §6 telemetry has to be addressable *by job* rather than
  readable only on the invoking connection (KFT §6, KCB §4).
* **One connection per dialed verb.** The subscriber is not the connection that opened the run;
  modelling that is the whole point, so each verb opens its own session to the published address.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from agora_trainer.app import BUDGET_HEADER, FROM_STEP_QUERY
from agora_trainer.cost import METER
from agora_trainer.manifest import CAPABILITY_NAME

#: The capability grant `invoke` requires — per-world, per-capability (KCB §5, KFT §7).
GRANT_VERB = f"invoke:{CAPABILITY_NAME}"

#: How long a subscription keeps waiting for a run the provider has not opened yet, and how long
#: it sleeps between attempts. Bounded on purpose: a job that never arrives must fail its watcher
#: with the provider's own `unknown-run` report, not hang it.
WATCH_TIMEOUT_SECONDS = 10.0
WATCH_INTERVAL_SECONDS = 0.01


class DialFailed(Exception):
    """A verb the provider refused, carrying its status and structured report (KFT §3.1).

    The report is the provider's, verbatim — a client that reworded it would hide which gate
    (`budget`, `egress-output`, `unknown-run`) actually fired.
    """

    def __init__(self, verb: str, status: int, body: dict[str, Any]) -> None:
        codes = tuple(str(problem.get("code")) for problem in body.get("problems", ()))
        super().__init__(f"`{verb}` refused with {status}: {', '.join(codes) or body}")
        self.verb = verb
        self.status = status
        self.body = body
        self.codes = codes


class Undiscoverable(Exception):
    """No provider on the dialed address advertises the capability this client needs (KCB §3)."""


@dataclass(frozen=True)
class GrantToken:
    """An `invoke:finetune` capability token (KCB §5) carrying its KFT §7 spend ceiling.

    Per-world and per-capability, and **unsigned**: issuing and signing grants is the calling
    workforce's governance (KCB §5/§6), which agora does not host. What rides the wire today is
    the ceiling — ``X-Agora-Budget-Units``, the one claim the provider's admission gate reads and
    enforces before provisioning (FT-E) — with the rest of the claims carried alongside it, so
    the shape a signed token will fill is already the shape being dialed.
    """

    #: The world the grant is scoped to (KCB §5 — grants are per-world).
    world: str
    #: The gpu-seconds ceiling; ``None`` is an ungated grant, which the provider admits.
    budget_units: float | None = None
    verb: str = GRANT_VERB
    meter: str = METER

    def claims(self) -> dict[str, Any]:
        """The token's claims — verb + scope + ceiling, the KCB §5 grant shape."""
        return {
            "verb": self.verb,
            "world": self.world,
            "budget_units": self.budget_units,
            "meter": self.meter,
        }

    def bearer(self) -> str:
        """The token as it rides ``Authorization`` — the claims, base64url, unsigned (US-6)."""
        raw = json.dumps(self.claims(), sort_keys=True).encode("utf-8")
        return "kcb-grant." + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def headers(self, *, ceiling: bool = True) -> dict[str, str]:
        """The grant's request headers. ``ceiling=False`` for verbs that spend nothing.

        Only `invoke` commits gpu-seconds, so only `invoke` carries the ceiling; sending it to a
        read verb would suggest a budget is being drawn down by reading a run's outputs.
        """
        headers = {"Authorization": f"Bearer {self.bearer()}"}
        if ceiling and self.budget_units is not None:
            headers[BUDGET_HEADER] = str(self.budget_units)
        return headers

    @staticmethod
    def claims_of(bearer: str) -> dict[str, Any]:
        """The claims back out of a bearer token — what a verifier reads once tokens are signed."""
        encoded = bearer.partition(".")[2]
        padded = encoded + "=" * (-len(encoded) % 4)
        claims: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded))
        return claims


@dataclass(frozen=True)
class Provider:
    """One discovered `finetune` provider — the addresses and terms its manifest published."""

    identity: str
    modality: str
    #: The capability's *own* endpoint (KCB §2) — where this modality's jobs are POSTed.
    invoke: str
    subscribe: str
    exports: str
    register: str
    grants_required: tuple[str, ...]
    meter: str
    #: The manifest's nominal figure (§2) — a caller sizes a grant against it, but the gate is
    #: the provider's per-job estimate (§7, FT-E), not this.
    est_units: float


@dataclass(frozen=True)
class Watch:
    """What one subscription saw: the ordered §6 events, and what it took to attach.

    ``attempts`` is load-bearing rather than diagnostic: a watcher that attached on its *second*
    attempt was already watching before the provider had a run to serve it (KFT §6).
    """

    events: tuple[dict[str, Any], ...]
    attempts: int

    @property
    def steps(self) -> tuple[int, ...]:
        return tuple(int(event["step"]) for event in self.events)

    @property
    def ids(self) -> tuple[str, ...]:
        """The content-addressed ``job + step`` ids — what makes redelivery idempotent (§6)."""
        return tuple(str(event["id"]) for event in self.events)

    @property
    def terminal(self) -> dict[str, Any] | None:
        """The single terminal event that ends the stream, or ``None`` if it never arrived."""
        last = self.events[-1] if self.events else None
        return last if last is not None and last.get("terminal") else None


@dataclass(frozen=True)
class Completed:
    """A whole dance: who answered, both copies of the stream, and what the run left behind."""

    provider: Provider
    grant: GrantToken
    #: The invoking connection's copy of the §6 stream.
    invoked: tuple[dict[str, Any], ...]
    #: The subscriber's copy — a different connection reading the same run (KCB §4).
    watched: Watch
    #: The §5.3 export matrix, when the client collected it.
    exports: dict[str, Any] | None = None
    #: The §8 registration, when the client registered the minted model.
    registration: dict[str, Any] | None = None

    @property
    def terminal(self) -> dict[str, Any]:
        return self.invoked[-1]

    @property
    def model(self) -> str:
        """The minted finetuned-model id the terminal event announced (§5.1/§5.2)."""
        return str(self.terminal["model"])


class FinetuneClient:
    """A KCB client for the `finetune` capability — discover, invoke, subscribe, collect.

    ``connect`` yields a fresh session per dialed verb (a wire deployment pools connections to
    the published host; in-process this hands each verb — and each thread — its own transport to
    the app under test). ``card_url`` is the *only* address the client is given.
    """

    def __init__(
        self,
        connect: Callable[[], httpx.Client],
        *,
        card_url: str,
        grant: GrantToken,
    ) -> None:
        self._connect = connect
        self._card_url = card_url
        self.grant = grant

    def discover(self, modality: str) -> Provider:
        """Agent card → KCB manifest → the capability that accepts ``modality`` (KCB §3, KFT §2).

        The manifest must both require the grant this client holds and advertise the addresses
        the dance needs; a provider that advertises neither is not one this client can drive, and
        saying so here beats a 404 three verbs later.
        """
        card = self._json("discover", "GET", self._card_url)
        manifest = self._json("discover", "GET", str(card["kcb_manifest"]))
        auth = manifest.get("auth", {})
        grants = tuple(str(grant) for grant in auth.get("grants_required", ()))
        if self.grant.verb not in grants:
            raise Undiscoverable(
                f"{manifest.get('identity')!r} does not require {self.grant.verb!r}; this client "
                "holds a grant for a capability it does not advertise (KCB §5)"
            )
        capability = self._capability(manifest, modality)
        endpoints = manifest.get("endpoints", {})
        missing = [verb for verb in ("subscribe", "exports", "register") if verb not in endpoints]
        if missing:
            raise Undiscoverable(
                f"{manifest.get('identity')!r} advertises no {', '.join(missing)} endpoint; the "
                "run's telemetry and outputs would be unreachable (KCB §4, KFT §5.3/§6/§8)"
            )
        cost = capability.get("cost", {})
        return Provider(
            identity=str(manifest["identity"]),
            modality=modality,
            invoke=str(capability["endpoint"]),
            subscribe=str(endpoints["subscribe"]),
            exports=str(endpoints["exports"]),
            register=str(endpoints["register"]),
            grants_required=grants,
            meter=str(cost.get("meter", METER)),
            est_units=float(cost.get("est_units", 0)),
        )

    def invoke(self, provider: Provider, job: dict[str, Any]) -> tuple[dict[str, Any], ...]:
        """`invoke` the job and read the caller's copy of the §6 stream (KCB §4, KFT §6).

        The grant's ceiling rides this request and nothing else — this is the verb that spends.
        An admission refusal (§3.1/§4.2/§7) is raised as :class:`DialFailed` carrying the
        provider's report, so the caller learns *which* gate refused it.
        """
        response = self._dial("POST", provider.invoke, json=job, headers=self.grant.headers())
        if response.status_code != 200:
            raise DialFailed("invoke", response.status_code, _body(response))
        return _events(response.text)

    def subscribe(
        self,
        provider: Provider,
        job: str,
        *,
        from_step: int = 0,
        timeout: float = WATCH_TIMEOUT_SECONDS,
        attached: threading.Event | None = None,
        abandon: threading.Event | None = None,
    ) -> Watch:
        """`subscribe` to a run's §6 stream through its terminal event (KCB §4, KFT §6).

        ``from_step`` resumes a dropped subscription at a cursor; redelivery is safe because the
        events carry the same content-addressed ids. A run the provider has not opened *yet* is a
        `404`, which this retries until ``timeout`` — the watcher may legitimately be watching
        before the job is dispatched. ``attached`` is set after every attempt, so a caller can
        sequence its dispatch behind a subscription that is genuinely in flight; ``abandon`` ends
        the wait early when that caller has learned the run will never open.
        """
        params: dict[str, Any] = {"job": job, FROM_STEP_QUERY: from_step}
        deadline = time.monotonic() + timeout
        attempts = 0
        while True:
            response = self._dial(
                "GET", provider.subscribe, params=params, headers=self.grant.headers(ceiling=False)
            )
            attempts += 1
            if attached is not None:
                attached.set()
            if response.status_code == 200:
                return Watch(_events(response.text), attempts)
            given_up = (abandon is not None and abandon.is_set()) or time.monotonic() >= deadline
            if response.status_code != 404 or given_up:
                raise DialFailed("subscribe", response.status_code, _body(response))
            time.sleep(WATCH_INTERVAL_SECONDS)

    def exports(self, provider: Provider, job: str) -> dict[str, Any]:
        """The run's §5.3 export matrix — the KMI assets it minted, with their lineage."""
        return self._json(
            "exports",
            "GET",
            provider.exports,
            params={"job": job},
            headers=self.grant.headers(ceiling=False),
        )

    def register(
        self, provider: Provider, job: str, *, across_boundary: bool = False
    ) -> dict[str, Any]:
        """Register the run's minted model (§8), under the §5.4 output-egress rule (FT-A)."""
        return self._json(
            "register",
            "POST",
            provider.register,
            json={"job": job, "across_boundary": across_boundary},
            headers=self.grant.headers(ceiling=False),
        )

    def finetune(
        self,
        job: dict[str, Any],
        *,
        collect: bool = True,
        across_boundary: bool | None = None,
    ) -> Completed:
        """The whole dance: discover → subscribe → invoke → collect (KCB §4, KFT §5.3/§6/§8).

        The subscription is opened **first**, on its own connection and its own thread, and the
        job is dispatched only once that watcher is in flight — the orchestrator's ordering, and
        the reason the watcher's first attempt legitimately meets a `404`. ``collect`` reads the
        §5.3 matrix once the run terminates; ``across_boundary`` additionally registers the
        minted model on that side of the trust boundary (§8), leaving it unregistered when
        ``None``, since where a model is indexed is the caller's decision, not the run's.
        """
        provider = self.discover(str(job["modality"]))
        job_id = str(job["job"])
        attached, abandon = threading.Event(), threading.Event()
        watched: list[Watch] = []
        refused: list[Exception] = []

        def _watch() -> None:
            try:
                watched.append(self.subscribe(provider, job_id, attached=attached, abandon=abandon))
            except Exception as exc:  # re-raised on the caller's thread, in dance order
                refused.append(exc)
            finally:
                attached.set()

        watcher = threading.Thread(target=_watch, name=f"watch:{job_id}", daemon=True)
        watcher.start()
        attached.wait(timeout=WATCH_TIMEOUT_SECONDS)
        try:
            invoked = self.invoke(provider, job)
        except DialFailed:
            abandon.set()  # nothing will ever open this run; stop the watcher waiting for it
            watcher.join(timeout=WATCH_TIMEOUT_SECONDS)
            raise
        watcher.join(timeout=WATCH_TIMEOUT_SECONDS)
        if refused:
            raise refused[0]
        exports = self.exports(provider, job_id) if collect else None
        registration = (
            self.register(provider, job_id, across_boundary=across_boundary)
            if across_boundary is not None
            else None
        )
        return Completed(
            provider=provider,
            grant=self.grant,
            invoked=invoked,
            watched=watched[0],
            exports=exports,
            registration=registration,
        )

    def _capability(self, manifest: dict[str, Any], modality: str) -> dict[str, Any]:
        """The advertised `finetune` capability that accepts ``modality`` (KFT §2, path search)."""
        for capability in manifest.get("capabilities", ()):
            if capability.get("name") == CAPABILITY_NAME and capability.get("modality") == modality:
                found: dict[str, Any] = capability
                return found
        raise Undiscoverable(
            f"{manifest.get('identity')!r} advertises no {CAPABILITY_NAME!r} capability accepting "
            f"modality {modality!r} (KFT §2 — one capability per modality)"
        )

    def _dial(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One request on its own session — the client holds no connection between verbs."""
        session = self._connect()
        try:
            return session.request(method, url, **kwargs)
        finally:
            session.close()

    def _json(self, verb: str, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        """A JSON verb: the parsed body, or the provider's refusal as :class:`DialFailed`."""
        response = self._dial(method, url, **kwargs)
        body = _body(response)
        if response.status_code >= 400:
            raise DialFailed(verb, response.status_code, body)
        return body


def _events(payload: str) -> tuple[dict[str, Any], ...]:
    """The §6 stream's newline-delimited JSON, parsed in arrival order."""
    return tuple(json.loads(line) for line in payload.splitlines() if line.strip())


def _body(response: httpx.Response) -> dict[str, Any]:
    """A response's JSON object, or a readable stand-in when it is not one."""
    try:
        body = response.json()
    except ValueError:
        return {"body": response.text}
    return body if isinstance(body, dict) else {"body": body}
