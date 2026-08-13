"""`subscribe` — the §6 telemetry stream as a live, subscribable surface (KCB §4, KFT §6).

Two subjects: the :mod:`~agora_trainer.journal` fan-out itself (ordering, blocking on a live run,
idempotent redelivery) and the HTTP `subscribe` verb a consumer that did not open the run dials.
"""

from __future__ import annotations

import json
import threading
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_trainer.app import app, get_runs
from agora_trainer.journal import RunJournal, RunRegistry
from agora_trainer.manifest import SUBSCRIBE_PATH
from agora_trainer.telemetry import TelemetryEvent
from conftest import valid_text_job

JOB = "orchestrator:activity:ft-run/9f2a"


@pytest.fixture(autouse=True)
def runs() -> Any:
    """A registry per test — runs are process state, and no test may see another's."""
    registry = RunRegistry()
    app.dependency_overrides[get_runs] = lambda: registry
    yield registry
    app.dependency_overrides.pop(get_runs, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _stream(response: httpx.Response) -> list[dict[str, Any]]:
    return [json.loads(line) for line in response.text.splitlines() if line]


def _event(step: int, *, terminal: bool = False) -> TelemetryEvent:
    return TelemetryEvent(
        job=JOB,
        step=step,
        ts=f"2026-08-06T00:00:{step:02d}Z",
        metrics={"train_loss": 1.0 / (step + 1)},
        terminal=terminal,
        model="agora:model:ft-x" if terminal else None,
        weights=("agora:asset:blake3-w1",) if terminal else (),
    )


class TestJournal:
    def test_a_subscriber_reads_the_ordered_sequence_to_the_terminal_event(self) -> None:
        journal = RunJournal(JOB)
        for step in range(3):
            journal.append(_event(step))
        journal.append(_event(3, terminal=True))
        events = list(journal.read())
        assert [e.step for e in events] == [0, 1, 2, 3]
        assert events[-1].terminal is True
        assert journal.closed is True

    def test_redelivery_is_idempotent_because_ids_are_content_addressed(self) -> None:
        """Two subscribers, and a reconnect with a cursor, see the same `job + step` ids (§6)."""
        journal = RunJournal(JOB)
        for step in range(3):
            journal.append(_event(step))
        journal.append(_event(3, terminal=True))
        first = [e.id for e in journal.read()]
        second = [e.id for e in journal.read()]
        resumed = [e.id for e in journal.read(from_step=2)]
        assert first == second
        assert resumed == first[2:]
        assert len(set(first)) == len(first)

    def test_a_subscriber_blocks_on_a_live_run_and_receives_the_tail(self) -> None:
        """The point of `subscribe`: attach mid-run and receive events as they are produced."""
        journal = RunJournal(JOB)
        journal.append(_event(0))
        received: list[TelemetryEvent] = []
        started = threading.Event()

        def _subscribe() -> None:
            for event in journal.read(idle_timeout=5.0):
                received.append(event)
                started.set()

        reader = threading.Thread(target=_subscribe, daemon=True)
        reader.start()
        assert started.wait(timeout=5.0)  # the recorded event arrives without waiting for more
        journal.append(_event(1))
        journal.append(_event(2, terminal=True))
        reader.join(timeout=5.0)
        assert not reader.is_alive()  # the terminal event ends the subscription
        assert [e.step for e in received] == [0, 1, 2]

    def test_a_run_that_dies_without_a_terminal_event_closes_rather_than_hangs(self) -> None:
        journal = RunJournal(JOB)
        journal.append(_event(0))
        journal.close()
        assert [e.step for e in journal.read()] == [0]

    def test_a_late_subscriber_still_replays_from_the_first_step(self) -> None:
        registry = RunRegistry()
        journal = registry.open(JOB)
        journal.append(_event(0))
        journal.append(_event(1, terminal=True))
        assert registry.get(JOB) is journal
        assert [e.step for e in registry.get(JOB).read()] == [0, 1]  # type: ignore[union-attr]

    def test_an_unknown_run_is_absent_from_the_registry(self) -> None:
        assert RunRegistry().get("orchestrator:activity:ft-run/nope") is None

    def test_retention_evicts_the_oldest_closed_run_but_never_a_live_one(self) -> None:
        registry = RunRegistry(retain=1)
        live = registry.open("job-a")
        registry.open("job-b")
        assert registry.get("job-a") is live  # still producing — retention yields to correctness
        live.close()
        registry.open("job-c")
        assert registry.get("job-a") is None
        assert registry.get("job-c") is not None


class TestSubscribeVerb:
    def test_a_consumer_that_did_not_open_the_run_reads_the_same_stream(
        self, client: TestClient
    ) -> None:
        invoked = _stream(client.post("/invoke", json=valid_text_job()))
        subscribed = _stream(client.get(SUBSCRIBE_PATH, params={"job": JOB}))
        assert subscribed == invoked
        steps = [e["step"] for e in subscribed]
        assert steps == sorted(steps)  # monotonic
        assert subscribed[-1]["terminal"] is True
        assert subscribed[-1]["model"].startswith("agora:model:ft-")
        assert subscribed[-1]["weights"]

    def test_the_stream_is_ndjson_tagged_with_the_job(self, client: TestClient) -> None:
        client.post("/invoke", json=valid_text_job())
        response = client.get(SUBSCRIBE_PATH, params={"job": JOB})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["x-agora-job"] == JOB

    def test_subscribing_twice_redelivers_identical_ids(self, client: TestClient) -> None:
        client.post("/invoke", json=valid_text_job())
        first = _stream(client.get(SUBSCRIBE_PATH, params={"job": JOB}))
        second = _stream(client.get(SUBSCRIBE_PATH, params={"job": JOB}))
        assert [e["id"] for e in first] == [e["id"] for e in second]
        assert len({e["id"] for e in first}) == len(first)

    def test_a_reconnecting_subscriber_resumes_from_its_cursor(self, client: TestClient) -> None:
        client.post("/invoke", json=valid_text_job())
        whole = _stream(client.get(SUBSCRIBE_PATH, params={"job": JOB}))
        cursor = whole[2]["step"]
        resumed = _stream(client.get(SUBSCRIBE_PATH, params={"job": JOB, "from": cursor}))
        assert resumed == whole[2:]
        assert resumed[-1]["terminal"] is True

    def test_an_unknown_run_is_a_reported_404_not_a_silent_empty_stream(
        self, client: TestClient
    ) -> None:
        response = client.get(SUBSCRIBE_PATH, params={"job": "orchestrator:activity:ft-run/nope"})
        assert response.status_code == 404
        body = response.json()
        assert body["ok"] is False
        assert [p["code"] for p in body["problems"]] == ["unknown-run"]

    def test_a_rejected_job_opens_no_run_to_subscribe_to(self, client: TestClient) -> None:
        """Admission runs before the journal exists — a 422 leaves nothing subscribable."""
        job = valid_text_job()
        del job["base_model"]
        assert client.post("/invoke", json=job).status_code == 422
        assert client.get(SUBSCRIBE_PATH, params={"job": JOB}).status_code == 404

    def test_the_manifest_advertises_the_subscribe_endpoint_it_serves(
        self, client: TestClient
    ) -> None:
        manifest = client.get("/.well-known/kcb-manifest.json").json()
        assert manifest["endpoints"]["subscribe"].endswith(SUBSCRIBE_PATH)
