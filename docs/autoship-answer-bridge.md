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
