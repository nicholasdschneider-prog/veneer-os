# AutoShip answer bridge (v1)

Contract between Veneer's native VeneerBots decisions and the OrderOps AutoShip
worker. Veneer supplies the human answer and its attribution; OrderOps owns
everything that turns that answer into shipping facts. Version `autoship-answer-bridge/v1`.

## What Veneer exposes

Every decision read (`list_decisions`, `GET /api/bots/decisions/:id`, the
`view()` in `server/src/bots/service.ts`) carries a read-only `answer_bridge`
object:

| field | meaning |
|---|---|
| `contract` | `autoship-answer-bridge/v1` |
| `current_version` | the decision's current proposal version (bumped by every revision) |
| `delivered_version` | highest version whose `answered` event finished native delivery to the owning bot (its wakeup is `delivered`); `null` until then |
| `answer.raw` | the human answer payload exactly as recorded: `action`, `text`, `scope` |
| `answer.actor_id` | the human user id that answered |
| `answer.actor_conversation_id` | always `null` for a human answer; a non-null value means a bot wrote the event and must never be treated as approval |
| `answer.answered_at` | event timestamp |
| `answer.request_key` | the caller-supplied key of the answer request; replaying it returns the same event |
| `parsedFacts` | not provided; parsing is the consumer's authority (below) |

`answer` is `null` whenever the current version has no human answer, including
right after a revision. The decision's `state` remains the authority for what
the answer permits: only `approve` at `delivered_version == current_version`,
followed by the bot's own `record_decision_result(state: running)` for that
version with unchanged material evidence, permits the blocked action.
`reply_to_decision` is discussion and never authorizes anything. Stale versions,
revised proposals and replayed keys fail closed exactly as today.

## What OrderOps owns

- Parsing natural-language dimensions and weight into an exact order, line
  composition and package version with explicit units and the full contents
  of every parcel in a multi-parcel answer.
- Clarifying an ambiguous answer through the existing decision thread
  (`update_decision` to revise the proposal, or `reply_to_decision` for
  discussion) instead of guessing a pack.
- Atomic teaching, ingress, ownership fence and idempotency across backfill,
  Flash, OrderQueue and Speed direct. Veneer does not duplicate that validator
  or authority.

## Scope of an approval

`proposal_json` for AutoShip decisions must carry `scope: 'order' |
'shared_template'` inside the proposal text or evidence the human sees. An
approval of an order-scoped decision authorizes that order's package version
only. OrderOps must refuse any reusable SKU template write unless the approved
version's scope is `shared_template`. Veneer's native approval never widens
scope silently.

## Independent verification (not yet available)

`answer_bridge` is a read for an authenticated Veneer identity. Railway cannot
independently verify it today: Cloudflare Access identities require an email
claim (service tokens are rejected), agent tokens are per-turn bot credentials,
and Veneer signs nothing outbound. Until a dedicated read-only verifier
principal or a Veneer-signed receipt is provisioned and built, OrderOps must
treat any copied answer as unverified, keep teach/enqueue disabled and report
readiness incomplete.

## Worker and dispatch state

The AutoShip worker is an ordinary enrolled bot (one operational chat enrolled
with `enroll_business_bots`, role `bot`, reporting to Finn for exception
oversight, no scheduled task or one with `enabled = 0`, no standing decision
rules). Its production dispatch and enqueue live service-side behind
OrderOps's fence and stay disabled until an explicit cutover owned by Henry.
Restarting Veneer, stopping the worker chat, or archiving it cannot change
dispatch state; only the service-side fence can.

## Verifier (option A)

Approved by Nick for a dedicated, server-scoped, read-only connection. Source:
`server/src/identity/autoshipVerifier.ts`, `server/src/bots/verifierRoutes.ts`,
`server/src/bots/canonical.ts`, the `autoshipProposalSchema` in
`server/src/bots/service.ts`.

### Identity

- A second Cloudflare Access application ("Veneer AutoShip Verifier") on the
  Veneer hostname, path `/api/autoship/verifier/*`, with one Service Auth
  policy allowing exactly one service token (`orderops-autoship-verifier`).
  Its audience tag is `VP_AUTOSHIP_VERIFIER_CF_AUD`; the token's client id is
  `VP_AUTOSHIP_VERIFIER_CLIENT_ID`. `VP_AUTOSHIP_WORKER_CHAT_ID` is the chat id
  of the verified AutoShip worker registration. All three are non-secret and
  live in `~/.config/veneer-pro/env`; any missing value disables the verifier.
- The JWT must verify against the team JWKS with that audience and carry
  `common_name` equal to the client id and no `email` claim. It yields a
  service identity with no users row, role, email or agent conversation. Email
  JWTs, agent tokens, the owner application's JWT and any other common_name
  are rejected on this path (401); the service JWT is rejected on every other
  path because the `/api` gate requires an email identity.
- Railway presents `CF-Access-Client-Id` / `CF-Access-Client-Secret` for the
  token; the secret lives only in the OrderOps Doppler config (`ervp/prd`:
  `AUTOSHIP_VERIFIER_BASE_URL`, `AUTOSHIP_VERIFIER_CF_ACCESS_CLIENT_ID`,
  `AUTOSHIP_VERIFIER_CF_ACCESS_CLIENT_SECRET`) and is materialized into the
  Railway service by the OrderOps runtime owner. `BASE_URL` is the fixed
  `https://<veneer-host>/api/autoship/verifier`; no caller URL or redirect is
  ever followed.

### Endpoint

`GET /api/autoship/verifier/decisions/:id?expected_version=N&request_key=K`

| status | meaning |
|---|---|
| 200 | the decision exists, is owned by the verified worker registration, has an `autoship_package` proposal, its `source_key` starts with `autoship:`, and `current_version == expected_version` |
| 409 | version mismatch; body carries only `current_version` plus the echoed request |
| 404 | anything else: unknown id, another bot's decision, a generic proposal, a source key outside the namespace, missing or malformed query, worker binding absent; the body is identical in every case |
| 401 | identity failure |
| 405 | any non-GET on the decision path |

Response body: `contract`, `served_at`, echoed `request_key` and
`expected_version`, and `decision` with `id`, `assigned_worker_id` (the owning
bot chat, never the human assignee), `worker_registration_active`,
`source_key`, `proposal_key`, `current_version`, `state`, `kind`, `binding`,
`binding_hash`, `proposal_hash`, `answer_bridge` and `result`.

- `binding` is the exact matchable set: `kind`, `scope`, `allow_solo_templates`,
  `order_id`, `merchant_order_number`, `orderops_id`, `shopify_order_id`,
  `lines[{line_id, sku, quantity}]`, `material_version`, `composition_key`,
  `composition_version`, `composition_source_hash`, `package_version`
  (non-negative integer, the local work CAS), `package_teaching_key`.
- `binding_hash` = SHA-256 of the canonical JSON of `binding`; `proposal_hash`
  = SHA-256 of canonical `{kind, source_key, proposal_key, binding}`.
  Canonical JSON: object keys sorted recursively, array order preserved, no
  whitespace, UTF-8. The server refuses to store a proposal whose
  `binding_hash` does not match.
- `answer_bridge.answer` adds `actor_is_human` (`actor_conversation_id` is
  null), `actor_active` (the user row is active) and `source`.
- `result` is one of `{kind: 'no_result'}`, `{kind: 'running', version}`,
  `{kind: 'terminal', state: verified_completed | blocked | failed, version}`.

### What the consumer must enforce

Authority exists only when all of: `state` is compatible (`decided`,
`action_pending` or `running` for the same version), `answer.raw.action ==
'approve'`, `answer_bridge.delivered_version == current_version ==
expected_version`, `actor_is_human && actor_active`, every binding field equals
the local expectation, `binding_hash` and `proposal_hash` match locally
computed values, and `scope`/`allow_solo_templates` permit the intended write.
`scope: 'order'` never authorizes shared-template writes; `shared_template`
alone never authorizes solo writes or enqueue. Terminal, revised, stale and
unknown states fail closed, as do 401/404/409, timeouts and unreachable.

### TOCTOU

A read is a snapshot, not a reservation. The decision can be revised or move
state between the read and the consumer's mutation; the consumer must re-read
at its mutation boundary with the same `expected_version`. A stricter
reservation would be a write on the decision and is separate scope, not
granted by this credential.

### Rotation and revocation

Rotate by creating a new service token in the Access application, setting the
two Railway keys, then deleting the old token. Revoking the token or deleting
the application makes every verifier request fail with 401; the consumer must
treat that as no authority.
