# `grants/` — the KCB §5 capability-grant issuer

The **issuance** half of koine's capability-grant model. KCB §5 fixes what a grant *is* — a token
naming a verb and a scope (`invoke:finetune`, `subscribe:world/consensus-reality`, `fetch:asset`),
per-capability and per-world, carrying a `budget_units` spend ceiling — and then says that "full
auth mechanics (token issuance, rotation, identity providers) live in the control-plane host's
infra". This is that infra, written once as a capability any host can run, rather than once per
host.

The split, end to end:

| Who | Does what |
|---|---|
| **koine** (`specs/capability-bus.md` §5) | fixes the grant **shape** and the `{key_id, alg}` signing shape. Normative. |
| **this service** | the reference **issuance runtime**: mints, signs, publishes verification material. |
| **relying parties** | **enforce**. `provider-router-erl/src/apr_grant.erl` refuses what a grant does not cover; `trainer/src/agora_trainer/grant.py` refuses a run over its ceiling. |

Nothing here enforces anything, and nothing there mints anything. The router says it plainly —
"the router is a relying party, never an issuer" — and this is the other end of the same sentence.

## The one rule that shapes the whole service

**An issuer must not mint what a relying party would refuse.** A token nobody can spend is worse
than an error, because it fails at the door of some third service with no path back to the
mistake. So the mint gate *is* the relying parties' parse: the §4 verb set, the `<verb>:<scope>`
split, the `*` / trailing-`/*` subtree spellings, and the ceiling read as the same scalar —
`src/grant.ts` mirrors them, and `src/relying-party.test.ts` reads both of those files off disk
and goes red when they drift. Nothing is imported across the language boundary (ADR-0001:
everything is shared over the wire, never as cross-language source); the trainer's real `Grant`
is *executed* over freshly minted grants in that same suite, so "the same scalar" is demonstrated
rather than asserted.

Carried across verbatim, because they are the point of having a ceiling at all:

- **A malformed ceiling is a refusal, never "no ceiling".** An authorization input the caller
  failed to state can never widen what the caller may do — at issuance as at enforcement.
- **An absent ceiling is unbounded, and only an absent one.**

## Capability, never caller

The issuer knows verbs, scopes and ceilings, and nothing about who is asking. The **grantee is
whatever principal the host names** — an opaque identity string it copies onto the grant, signs,
and never interprets. No participant is named in this tree.

## Running it

```sh
npm start -w @agora/grants          # 127.0.0.1:8791
```

| Route | What it does |
|---|---|
| `POST /grants` | mint one grant: `{grantee, scope, budget_units?}` (or `{grantee, verb, scope, …}`) → a signed grant |
| `GET /keys` | the public material to verify with, so a relying party polls instead of dialing per request |
| `GET /describe` | what this is, and what it will not do |

```sh
curl -sX POST localhost:8791/grants \
  -d '{"grantee":"example:agent:principal","scope":"invoke:finetune","budget_units":250}'
```

```json
{
  "verb": "invoke",
  "scope": "finetune",
  "budget_units": 250,
  "grantee": "example:agent:principal",
  "signature": { "key_id": "issuer-1", "alg": "ed25519", "value": "…" }
}
```

A refusal is graded the way `apr_grant:parse/1` grades one — **403** you are not authorized,
**422** you sent something unreadable — so an operator reading two logs reads one vocabulary.

Signing is asymmetric on purpose: a relying party must be able to verify from published material
without dialing the issuer per request, which a shared secret would force. With no
`AGORA_GRANTS_KEY` the process generates a key pair at boot — right for a demo, wrong for a
deployment, and the log line says which happened.

## Gate

```sh
make check-grants
```
