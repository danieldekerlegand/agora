"""The run journal — the live §6 telemetry log a `subscribe`r attaches to (KCB §4).

`invoke` streams the KFT §6 training-telemetry back to the *caller that started the run*. But §6
is explicit that a consumer **`subscribe`s** to that stream (KCB §4) — the orchestrator issuing
the job and a console watching it are not the same connection, and a subscriber that attaches
late, or reconnects mid-run, must still receive the ordered sequence through the terminal event.
This module is that fan-out: the run writes each event it emits into a per-job journal, and any
number of subscribers read the journal — from the beginning or from a cursor — while the run is
still producing.

Two contractual properties (KFT §6) are what make this a journal rather than a socket:

* **Ordered and replayable.** Events are appended in the run's monotonic ``step`` order and kept,
  so a subscriber that attaches after step 40 still receives steps 0..40 before the live tail. The
  stream ends at the single terminal event; a run that dies without one closes the journal anyway,
  so no reader hangs forever.
* **Idempotent under redelivery.** Nothing here mints ids — an event redelivered to a second
  subscriber, or re-read after a reconnect, is the *same* :class:`~agora_trainer.telemetry.
  TelemetryEvent` with the same content-addressed ``job + step`` id, which is exactly what lets
  the stream skip an exactly-once transport (KCB §4).

Retention is in-memory and bounded (:data:`RETAINED_RUNS`): this is a provider-local read model,
not a durable event store — a deployment that must survive a restart persists the same events
behind the same interface. Eviction is oldest-first and only ever drops *closed* runs, so a live
run is never yanked out from under its subscribers.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Iterator

from .telemetry import TelemetryEvent

#: How many runs' journals are retained in memory, oldest closed run evicted first.
RETAINED_RUNS = 32

#: How long a subscriber waits for the next event of a still-running job before giving up. A
#: recorded run emits continuously, so this bounds a *stalled* run (a dead engine, a producer
#: that never closed the journal), not a slow one.
IDLE_TIMEOUT_SECONDS = 30.0


class RunJournal:
    """One run's §6 events — appended by the run, read by any number of subscribers.

    Thread-safe by construction: the run producing events and the subscribers reading them are
    different requests on different threads.
    """

    def __init__(self, job: str) -> None:
        self.job = job
        self._events: list[TelemetryEvent] = []
        self._closed = False
        self._changed = threading.Condition()

    @property
    def closed(self) -> bool:
        """True once the run reached its terminal event (or ended without one)."""
        with self._changed:
            return self._closed

    def append(self, event: TelemetryEvent) -> None:
        """Record one emitted event and wake every waiting subscriber.

        The terminal event closes the journal — it is the end of the stream by contract (§6), so
        a subscriber does not wait past it.
        """
        with self._changed:
            self._events.append(event)
            if event.terminal:
                self._closed = True
            self._changed.notify_all()

    def close(self) -> None:
        """Close the journal without a terminal event — the run ended or the producer went away.

        Idempotent, and safe to call after a terminal event already closed it. Without this a run
        that died mid-stream would leave its subscribers waiting on a step that never comes.
        """
        with self._changed:
            self._closed = True
            self._changed.notify_all()

    def replay(self) -> tuple[TelemetryEvent, ...]:
        """Every event recorded so far, in order — a snapshot, no waiting."""
        with self._changed:
            return tuple(self._events)

    def read(
        self, *, from_step: int = 0, idle_timeout: float = IDLE_TIMEOUT_SECONDS
    ) -> Iterator[TelemetryEvent]:
        """The ordered events from ``from_step`` onward, through the terminal event.

        Replays what is already recorded, then blocks for the live tail until the journal closes.
        ``from_step`` is a *step* cursor, not an offset: a subscriber that reconnects resumes from
        the step after the last one it saw, and re-reading an already-seen step is safe because the
        redelivered event carries the same id (§6). ``idle_timeout`` bounds a stalled run; hitting
        it ends the iteration rather than raising, since a truncated stream is what a subscriber
        of a dead run actually observes.
        """
        index = 0
        while True:
            with self._changed:
                while index >= len(self._events) and not self._closed:
                    if not self._changed.wait(timeout=idle_timeout):
                        return
                if index >= len(self._events):
                    return
                event = self._events[index]
            index += 1
            if event.step >= from_step:
                yield event


class RunRegistry:
    """The trainer's live runs, keyed by KFT ``job`` (the KINP activity id of the run).

    One per process. A job id is minted per run (§5.2, FT-C), so re-`invoke`ing the same job id
    replaces the previous journal rather than interleaving two runs into one stream.
    """

    def __init__(self, retain: int = RETAINED_RUNS) -> None:
        self._retain = retain
        self._runs: OrderedDict[str, RunJournal] = OrderedDict()
        self._lock = threading.Lock()

    def open(self, job: str) -> RunJournal:
        """Register a journal for ``job`` and return it, evicting the oldest closed run."""
        journal = RunJournal(job)
        with self._lock:
            self._runs.pop(job, None)
            self._runs[job] = journal
            self._evict()
        return journal

    def get(self, job: str) -> RunJournal | None:
        """The journal for ``job``, or ``None`` when no such run is known to this process."""
        with self._lock:
            return self._runs.get(job)

    def _evict(self) -> None:
        """Drop the oldest *closed* runs until the registry is within its retention bound."""
        while len(self._runs) > self._retain:
            for job, journal in self._runs.items():
                if journal.closed:
                    del self._runs[job]
                    break
            else:  # every retained run is still live — retention yields to correctness
                return
