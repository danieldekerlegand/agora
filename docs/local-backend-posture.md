# The local backend posture — bind, auth, and the default that is never inherited

**Status:** the standing rule for the router's keyless local tiers (`mlx`, `local`).
**Applies to:** `provider-router/src/agora_provider_router/backends.py` and its Erlang mirror
`provider-router-erl/src/apr_backends.erl` — the two must state it identically, per
ADR-0004.

**Reads with:** [the LiteLLM spike](spike-litellm-leaf.md) §N2/N3, where the inherited
default was caught, and [the hand-built inventory](router-hand-built-behaviours.md) §2.3,
whose guards any change to a dispatch path has to re-prove.

The local rungs are the two the router dials without a key: `mlx-serve` and `ollama`. They
are different in kind from the paid rungs, and the difference is not that they are free. A
paid vendor's address is **public vocabulary** — `https://api.openai.com/v1` is the same
string on every machine in the world, so the router can ship it. A local backend's address
is a **fact about one operator's machine**, and the software behind it — Ollama, mlx-serve —
ships *unauthenticated*, on the assumption that only that machine can reach it. Three rules
follow — where its address comes from, where it is bound, what authenticates it — and a
fourth about the rest of the time, when it is not answering at all. This document is the
four.

---

## 1. The address is never inherited, only configured

A local rung exists **if and only if** an operator configured a base URL for it:
`AGORA_PROVIDER_OLLAMA_BASE_URL` (or the `OLLAMA_BASE_URL` / `OLLAMA_HOST` fallback
spellings), `AGORA_PROVIDER_MLX_SERVE_BASE_URL` (or `MLX_SERVE_BASE_URL`). With none set the
tier resolves `unconfigured` and the ladder walks past it.

The router never assumes a port. Client libraries do — LiteLLM defaults `ollama` to
`http://localhost:11434`, and it is not alone — and inheriting such a default would make
"no local server configured" a claim about *whatever happens to be listening on the box*
rather than about the configuration. That is exactly the state the zero-spend invariant has
to be able to assert, so the default is **overridden, not inherited**, and the rule is
stated twice:

| where | what holds it |
|---|---|
| resolution | `resolve_tier` → `unconfigured` with no backend built (`apr_backends:resolve_tier/4`) |
| dispatch | `dispatch_url` raises `UnconfiguredLocalAddress` / returns `{error, _}` (`apr_backends:dispatch_url/1`) |

Twice, because the two answer different questions. Resolution answers *"is there a rung"*;
a transport answers *"where do I send it"* — and a library layered under the second can
reintroduce what the first refused. A refusal at dispatch is not an error the caller sees:
to `Router.complete` it is one more rung that did not answer, recorded `dialed=false`, and
the walk continues to the terminal tier.

The borrowed LiteLLM adapter (`AGORA_LITELLM=1`) is not an exception. It checks the tier
*before* its vendor table, so a local rung stays on the direct POST and never reaches the
library at all — see `litellm_dispatch.py` and `tests/test_litellm_dispatch.py`.

## 2. The expected bind is loopback, and anything else is said out loud

An unauthenticated Ollama or mlx-serve is safe **because of where it is bound**, not because
of anything the router does. The expected deployment is therefore loopback:
`http://127.0.0.1:11434/v1`, `http://localhost:11434/v1`, `http://[::1]:8080/v1`.

The router does not enforce that — an operator who runs a local model server on another
machine on their network has a real deployment, and refusing it would be this commons
deciding somebody's topology for them. What it does instead is **classify and report**:

* `local_bind(base_url)` (`apr_backends:local_bind/1`) answers `loopback` or `remote` from
  the configured string alone. It never resolves DNS — the classification is a fact about
  the configuration, not about a nameserver at some later moment.
* Anything not *demonstrably* loopback is `remote`. A host that only a resolver could settle
  is the operator's to explain, and the safe reading of "I could not tell" is "it leaves the
  box" — that is the reading under which an unauthenticated backend is the operator's
  explicit choice rather than the router's silent one.
* A local backend reports its posture on `/doctor` as a `bind` field, next to its
  `base_url`. Only local rungs carry it: a paid vendor's address describes nobody's network.
* A `remote` rung still resolves `ready`, and carries a `reason` saying so. A reason on a
  *ready* rung is the one thing `/doctor` says about a rung it is otherwise happy with,
  which is the weight this deserves: allowed, because configured; never silent, because the
  software behind it was designed for a loopback interface.

So a remote-local backend is an **explicit, visible operator choice**. It cannot be arrived
at by accident, because rule 1 means it cannot be arrived at without being typed.

## 3. Auth is optional, carried when configured, and never fabricated

Keyless is the local tiers' *default* posture, not a rule about them. An operator who has
put their local server behind a reverse proxy, or is reaching one across a network under
rule 2, has a credential for it — and the router carries it:

```sh
AGORA_PROVIDER_OLLAMA_BASE_URL=https://ollama.internal.example/v1
AGORA_PROVIDER_OLLAMA_API_KEY=…            # optional; sent as `authorization: Bearer …`
```

`dispatch_headers` (`apr_backends:dispatch_headers/1`) is the single place that decides,
for every tier alike: `content-type: application/json`, plus `authorization` **iff** a
non-empty credential was configured. With none configured there is no `authorization` header
at all — not an empty bearer, which a permissive backend would accept and a strict one would
reject for the wrong reason.

The credential is a `SecretStr` like any other, so it is absent from every `describe()`,
log line and response body, and it is redacted out of any transport error that quotes the
URL it was dialing (`router.py::_reason`, `apr_rung_worker:redact/2`).

## 4. Every way it can fail is an ordinary state

The three rules above are about a local backend that *works*. This one is about the rest of
the time, and it is what makes the other three safe to hold: the local tier is the one rung
whose **server is the operator's own**. Nobody runs an SLA on the Ollama on somebody's
laptop, so a local backend that is absent, refusing connections, hung, or answering with
something that is not a completion is not an exceptional condition — it is Tuesday. Each is
one more rung that did not answer, and the ladder's answer to a rung that did not answer is
the next rung, ending at the deterministic zero-spend placeholder.

| failure | what the ladder does | how the attempt reads |
|---|---|---|
| **absent** — no base URL configured (rule 1) | walks past it, contacting nothing | `dialed=false`, reason `… base URL not set` |
| **refused** — configured, server not running | records the transport error, walks on | `dialed=true`, the redacted error |
| **hung** — connection accepted, no answer | the per-rung deadline fires (`DEFAULT_TIMEOUT` / `call_timeout`) | `dialed=true`, a timeout |
| **malformed** — it answered, and it is not a completion | refuses the answer, walks on | `dialed=true`, `malformed response: expected a JSON object, got …` |

The last row is a rule in its own right, and it is why a half-implemented `/v1` shim in
front of a model server cannot corrupt a report: every modality's response is read out of a
JSON **object** — `usage` for what a text call billed, `data` for the artifacts an image or
music call returned — so a bare array, string or number would be settled, relayed and
reported as though it were a completion. It is refused at the same place in both routers
(`router.py::_malformed`, `apr_rung_worker:malformed/1`), with the same wording, and it
counts as **dialed**: the backend was contacted and may well have billed, which is exactly
what a budget audit needs to be told apart from a rung that was skipped on price.

`dialed=false` on the absent case is the same distinction from the other side. Nothing was
contacted, so nothing could have been spent — "no local server configured" stays a statement
about configuration all the way through the failure path, not just at resolution.

None of this relaxes a ceiling. A fall-through is not a licence to spend: the rung *under* a
failed one is priced before it is dialed like any other, an `unpriced` rung never passes a
ceiling however many rungs above it failed, and `resolve_all` still answers — which is the
§2.3 re-proof this posture's dispatch paths owe.

## 5. What is asserted, and where

| rule | Python | Erlang |
|---|---|---|
| no rung without a configured address | `tests/test_local_backend.py` | `test/apr_local_backend_tests.erl` |
| no transport substitutes a default | `tests/test_local_backend.py` | `test/apr_local_backend_tests.erl` |
| the library default is unreachable | `tests/test_litellm_dispatch.py` | (adapter is Python-only) |
| bind classification and reporting | `tests/test_local_backend.py` | `test/apr_local_backend_tests.erl` |
| auth carried, never fabricated | `tests/test_local_backend.py` | `test/apr_local_backend_tests.erl` |
| failure modes leave the ladder intact | `tests/test_local_failure_modes.py` | `test/apr_local_failure_SUITE.erl` |

The `bind` field is on the external surface, so it is a dual-router change by definition: it
lands in both or in neither, and `apr_conformance_SUITE` replays the corpus that proves it.
The corpus environments configure no local backend, so no ready local rung appears in it —
`tests/test_python_surface_corpus.py` is what says whether that is still true.
