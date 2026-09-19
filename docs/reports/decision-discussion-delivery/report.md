# Decision discussion delivery — build 84

## Incident finding

Read-only diagnosis of decision `8859b06f-84d5-456e-bc37-8506bf5d1414` in Grant’s existing conversation `cb4ade24-c960-4235-956a-220260e5adac` found all three human discussion events durable but still queued. No evidence of lost wake records or a restart-caused incident was established.

| Human message ID | Created UTC, September19 | Runtime queue acceptance UTC | Durable queue ID |
|---|---|---|---|
| 61e6dda7-51b2-45ae-8a54-083a4971bd87 | 21:16:28 | 21:16:30.248 | 4 |
| 08c6b9a8-7d3f-4468-ace3-b3346cc2ffd0 | 21:48:55 | 21:48:55.147 | 8 |
| d55fb343-c0eb-4fc2-a815-d25aebd11c3a | 22:08:44 | 22:08:46.232 | 9 |

Each runner log entry reported `disposition=queued`. Each wakeup had a matching `wakeup:<event-id>` inbound receipt. The decision was `needs_input`, version1, with no answer/result and no bot discussion reply at inspection. These are incident-time observations, not assertions about current customer work.

Cause: decision discussion wakes called `deliverWakeup`, which durably enqueued but never used live steering. A long-running owner could continue unrelated work while human discussions waited for the turn boundary. The scheduler’s `delivered` state means runtime queue acceptance, not provider consumption or a reply.

## Repair

New human decision discussions reuse the existing steering acknowledgment path **with the original durable queue item**. There is no second enqueue, new executor or interruption. Only a native `message` decision event authored by a human qualifies. Approval answers, bot replies and ordinary scheduled wakes keep their existing delivery behavior.

Before delivery, bot registration, conversation/decision access, evidence access and proposal version are rechecked. If live steering is unsupported, unsafe for the active actor, temporarily unavailable, or fails, the original queue item remains available for the next eligible turn. New queued discussion items are checked again for access/version changes before running; superseded or revoked items are removed from the runtime queue with an audit entry, without changing the human decision.

The queue row, idempotency receipt and initial discussion delivery audit marker are committed together. The provider-consumed audit entry and removal of the durable fallback are also committed together. Retrying scheduler acceptance uses the existing receipt and cannot write the same steer again. A provider acknowledgment retires only the original turn’s queue item; unacknowledged input retains the established restart fallback.

Append-only `discussion_delivery` audit entries distinguish `queued`, `queued_fallback` (with reason), `written_awaiting_ack`, `provider_consumed`, `turn_started`, and `cancelled`. They appear in the existing Decision history audit. `turn_started` is runtime turn dispatch, not proof of completion; provider consumption is not a promise that the bot has replied.

## Safety and limits

- No live GVLGU5 message was replayed, removed, approved or otherwise changed during investigation or testing. No customer/finance/schedule action was performed.
- No backfill, queue sweep or auto-steer of older delivered incident messages is included. Existing messages retain their ordinary queue semantics. Henry has already contacted Grant, so any incident recovery must first reconcile Grant’s response with the outstanding queued content; this build does not perform that recovery.
- No schema migration, registration, ownership/model change, or expansion of financial/tool authority.
- The existing runtime intentionally retains an unacknowledged line across process death. Provider-level exactly-once execution cannot be promised when a process dies after reading input but before acknowledging it. This patch prevents duplicate scheduler enqueue/steer and duplicate post-ack fallback; it does not turn discussion into execution authorization.
- No UI code changed. No browser/customer session was needed for the runtime-only repair.

## Validation

[Focused output](./scoped-tests.txt): **64 passed**, including new active-owner steering, late acknowledgment/fallback removal, unsupported steering, different actor, failed write, proposal/access drift, crash-after-enqueue receipt retry, fresh-runtime queue recovery, and unchanged approval/ordinary wake routing. Existing steering tests cover maintenance, stopped/replaced turns, delayed/failed acknowledgment and idle delivery. Existing bot tests cover same-owner threaded replies, ACL, stale versions and durable answer delivery.

[Typecheck output](./typecheck.txt), [full-suite output](./full-tests.txt), [build output](./build.txt). **Typecheck and production build passed; full suite: 2,902 passed, 5 existing skipped.** Build emitted only the existing Vite chunk-size advisory.

## Files changed

- [Discussion classification and immutable delivery audit](/Users/archerclawdington/veneer-os/server/src/bots/delivery.ts)
- [Same-queue-item steering and queued delivery revalidation](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Isolated runtime integration tests](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)

## Deployment

Pending final required checks and root restart. No historical message replay or migration is required for adoption.
