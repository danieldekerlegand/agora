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
| **koine** (`specs/capability-bus.md` §5) | fixes the grant **SHAPE** and the `{key_id, alg}` signing shape. Normative, and re-specified nowhere else. |
| **this service** | the reference **issuance runtime**: mints, signs, rotates, caps and attenuates — one implementation any control-plane host can run instead of writing its own. |
| **relying parties** | **ENFORCE**. `provider-router-erl/src/apr_grant.erl` refuses what a grant does not cover; `trainer/src/agora_trainer/grant.py` refuses a run over its ceiling. |

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
| `POST /grants/derive` | narrow a grant the caller holds: `{parent, scope, budget_units?, grantee?}` → a signed child |
| `GET /keys` | the public material to verify with, so a relying party polls instead of dialing per request |
| `GET /describe` | what this is, what it will not do, and the ceiling policy it applies |
| `GET /.well-known/agent-card.json` | the A2A card carrying this issuer's KCB manifest |
| `GET /.well-known/kcb-manifest.json` | that manifest bare, which is what a registry crawl pulls |

Configured entirely from the environment:

| Variable | Default | What it sets |
|---|---|---|
| `AGORA_GRANTS_KEY_ID` | `issuer-1` | the `key_id` grants are minted under |
| `AGORA_GRANTS_KEY` | *(generated)* | the ed25519 private key, PEM |
| `AGORA_GRANTS_LIFETIME` | `3600` | how long a minted grant counts for, in seconds |
| `AGORA_GRANTS_PREVIOUS_KEY_ID` / `_KEY` | — | the key being rotated **out**, kept verifying |
| `AGORA_GRANTS_OVERLAP` | `86400` | how long that outgoing key keeps verifying, in seconds |
| `AGORA_GRANTS_CEILINGS` | *(no caps)* | the operator's spend caps, as JSON |
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

## Ceilings: the policy that only ever narrows

`budget_units` on a grant is the *caller's* ceiling. The ceiling on **what may be asked for** is
the host's, and that is the operator's ceiling policy — a small set of per-scope caps applied to
every mint before anything is signed:

```jsonc
{
  "mode": "clamp",                                            // or "refuse"
  "caps": [
    { "scope": "*", "max_units": 1000 },
    { "scope": "world/*", "verb": "subscribe", "max_units": 100 },
    { "scope": "finetune", "verb": "invoke", "max_units": 50 }
  ]
}
```

Three rules, and the first is where the other two come from:

- **An absent ceiling is unbounded**, here as at every relying party — so a request that states
  no ceiling asks for *more* than any cap, and is answered exactly as an over-cap number is:
  clamped to the cap, or refused. This is `apr_grant`'s rule — *an authorization input the caller
  failed to state can never widen what the caller may do* — holding at **issuance** as well as at
  enforcement. A policy with a cap can never mint an unbounded grant on a scope that cap reaches.
- **The tightest applicable cap binds**, and a cap applies to any scope the grant could be spent
  on: a grant for `world/*` is spendable on `world/consensus-reality`, so a cap on that world
  binds it. Specificity ordering would make one policy mean different things depending on how it
  was written down; "the smallest wins" fails closed and reads the same in any order.
- **A cap only narrows.** There is no way to spell a policy that raises a requested ceiling. A
  policy that could hand out more than was asked for is not a cap.

`mode` is the host's call on the two ways to answer an over-cap request. `clamp` mints at the cap
— right where a caller asks generously and takes what it is given. `refuse` answers **403** and
names the cap — right where a caller that would overspend should find out at the mint rather than
at some later gate, halfway through a chain.

## Attenuation: what a chain hands its next hop

KCB §5 puts a ceiling on a grant for one reason: *"a cross-participant chain (knowledge producer
→ media producer → paid model) cannot exceed the caller's authorized spend"*. A chain is
participants calling participants, and a participant that hands its own credential downstream to
get work done has handed over everything that credential authorizes. Attenuation is the
alternative — derive a narrower grant for the next hop and hand *that* down:

```sh
curl -sX POST localhost:8791/grants/derive \
  -d '{"parent": <the grant you hold>, "grantee":"example:agent:next-hop",
       "scope":"world/consensus-reality", "budget_units": 25}'
```

Four dimensions, all one-way:

| Dimension | The child may | Because |
|---|---|---|
| `verb` | keep the parent's | a `subscribe` grant is not an `invoke` grant in disguise |
| `scope` | keep it, or take one the parent covers | `world/*` → `world/x`, never the reverse |
| `budget_units` | keep it, or take less | §5's chain rule, spelled directly |
| `expires_at` | end when the parent does, or sooner | a child outliving its parent re-mints authority the parent already lost |

The parent is **verified before a single claim of it is read** — an unverified parent would let a
caller narrow from a grant it wrote itself — and the same 403/422 grading applies: a widening
derivation is a `403`, an unreadable request is a `422`. An unstated child ceiling *inherits* the
parent's rather than becoming unbounded, for the same reason the policy clamps an unstated one:
the caller who said nothing gets exactly what it held, which is the only reading that cannot
widen. Both narrowings compose — the child ends at the tighter of the parent's ceiling and the
operator's cap, however the request was phrased.

A derived grant carries `derived_from`, a fingerprint of its parent, so a chain is attributable
after the fact. A fingerprint and not the parent itself: a child that embedded its parent would
hand every downstream hop the very authority attenuation exists to withhold.

## Discovery

The issuer publishes its own KCB manifest (`src/manifest.ts`) — `grant.issue` and `grant.derive`,
each with its address, both `est_units: 0` — as an AgentCard extension and as the bare body a
registry crawl pulls (§3). A host finds it the way it finds anything else:

```ts
registry.find({ capability: 'grant.issue' })[0].capabilities[0].endpoint  // → where to mint
```

What comes back is an **address**, and the caller mints directly against it
([ADR-0001](../../koine/decisions/ADR-0001-control-plane-topology.md) decision 3). A credential
that travelled through the registry would make the registry a party to every authorization on the
fabric, and this service is not in anybody's data path either: it hands back a grant and forgets
it.

The manifest advertises **no `grants_required`**, deliberately. §5 leaves identity providers to
the control-plane host's infra, so what authorizes a *mint* is whatever the host fronts this
surface with; what authorizes a *derivation* is the presented parent grant itself. Advertising
`invoke:grant.issue` would claim a grant you would need this very service to obtain.

## Gate

```sh
make check-grants
```
