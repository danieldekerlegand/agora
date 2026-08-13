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

Configured entirely from the environment:

| Variable | Default | What it sets |
|---|---|---|
| `AGORA_GRANTS_KEY_ID` | `issuer-1` | the `key_id` grants are minted under |
| `AGORA_GRANTS_KEY` | *(generated)* | the ed25519 private key, PEM |
| `AGORA_GRANTS_LIFETIME` | `3600` | how long a minted grant counts for, in seconds |
| `AGORA_GRANTS_PREVIOUS_KEY_ID` / `_KEY` | — | the key being rotated **out**, kept verifying |
| `AGORA_GRANTS_OVERLAP` | `86400` | how long that outgoing key keeps verifying, in seconds |
| `AGORA_GRANTS_HOST` / `_PORT` | `127.0.0.1:8791` | bind address |

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
  "expires_at": "2026-08-13T13:00:00.000Z",
  "signature": { "key_id": "issuer-1", "alg": "ed25519", "value": "…" }
}
```

A refusal is graded the way `apr_grant:parse/1` grades one — **403** you are not authorized,
**422** you sent something unreadable — so an operator reading two logs reads one vocabulary.

Signing is asymmetric on purpose: a relying party must be able to verify from published material
without dialing the issuer per request, which a shared secret would force. With no
`AGORA_GRANTS_KEY` the process generates a key pair at boot — right for a demo, wrong for a
deployment, and the log line says which happened.

## Rotation, expiry, and what a relying party actually holds

A grant is a bearer credential that is already in somebody else's hands when the key under it
changes, so a rotation is two events rather than one. **Rotate** and the successor becomes the
minting key while the outgoing key keeps *verifying* — and keeps being published — for a declared
overlap window. **Retire** and that window ends, by reaching its `not_after` or because an
operator ended it early; the key stops verifying and leaves the published set. The overlap is
therefore the longest a grant may outlive its key, and a host sets it against the lifetime of the
grants it mints, never the other way round.

Every grant carries an `expires_at`, and **there is no way to mint one that does not**. This
issuer deliberately keeps no ledger of what it minted — it is not in the enforcement path, and a
list it never consults is only a liability — which means it has nothing to revoke *from*. Ageing
out is how a credential stops being one; retiring a key is the coarse instrument beside it,
ending every grant signed under that key at once.

`GET /keys` is the stable seam. It serves `{keys: [{key_id, alg, public_key, not_after?}]}` — the
current key first, then any key still inside its overlap, each carrying the instant it stops
counting — with a `max-age` short enough that a poller sees a rotation long before the window it
opened could close. A relying party polls it and verifies **locally**; nothing dials the issuer
per request, which is what asymmetric signing is for, and an issuer that had to be reachable to
authorize anything would be the hub [ADR-0001](../../koine/decisions/ADR-0001-control-plane-topology.md)
decision 3 rules out for the registry and which is no better here.

There is no rotation route, on purpose. Minting is open to whoever the host puts in front of this
surface; deciding *which keys verify* is not the same authority, and behind one unauthenticated
door anyone who could ask for a grant could retire the key holding everybody else's. Rotation is
an operator action — `issuer.rotate(next, {overlapMs})` in process, or a redeploy carrying the
incumbent as `AGORA_GRANTS_PREVIOUS_KEY`.

## Verifying, downstream

The check itself is one small function, `src/verify.ts`, taking the key set exactly as `/keys`
served it:

```ts
import { createGrantVerifier } from '@agora/grants';

const verify = createGrantVerifier({ keys: () => lastPolled }); // a getter follows rotations
const grant = verify(presented); // → IssuedGrant, or a graded GrantError
```

It is one function and not a paragraph of instructions because every enforcing service has to
answer the same four questions — is this a grant at all, was it signed by a key this issuer
published, does the signature cover these claims, is it still inside its lifetime — and each
service answering them for itself is four chances to answer one of them differently. A verifier
reading the expiry with `<=` where another reads `<` disagrees by exactly one millisecond per
grant, forever, and nobody finds out.

The refusals keep the router's vocabulary:

| Refusal | Status |
|---|---|
| no grant presented | `403` |
| not a grant: unknown verb, malformed ceiling, no signature, unreadable `expires_at` | `422` |
| signed by a key that is not published, or one whose overlap ended | `403` |
| signature does not cover these claims | `403` |
| past `expires_at` | `403` |

An expiry is a refusal and not an error because "your grant expired at T, get another" is a
sentence the caller can act on and a `500` is not.

## Gate

```sh
make check-grants
```
