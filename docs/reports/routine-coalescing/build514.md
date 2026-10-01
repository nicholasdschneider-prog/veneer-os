# Recurring routine backup checks — build 514

October 1, 2026. Platform-only implementation for coordination thread
`c5c3ca8d-4e59-435d-ab4b-b822383f45bf`. ERVP source, build 513, Henry/AutoShip
schedule intervals and customer execution authority are outside this change.

## Behavior

Each recurring bot routine retains one undispatched backup check across both
`conversation_wakeups` and the durable chat queue. A tick that finds one records
its delivery against that existing wake and advances the schedule normally.
Once a check starts, a later tick can retain one additional pending check.
This applies to bot routines, not the separate scheduled-agent subsystem.

The runner reconciles proven redundant backups on queue recovery, before wake
delivery and before dispatch. It retains the oldest queued check (or oldest
pending wake when none is queued). Removed queue rows are serialized into
`bot_routine_coalescing`; routine deliveries and inbound idempotency receipts
remain. A retry cannot resurrect a coalesced check. No customer send is performed
by this change.

Classification requires structured routine/wake/receipt relationships. New
deliveries carry producer kind (`periodic`, `once`, or `event`). Legacy rows
additionally require a current recurring schedule, an exact scheduler event ID,
matching actor/conversation/key and unchanged generated payload. Payload equality
is an integrity check, not a keyword classifier. Edited or ambiguous rows remain.
Customer/order events, human messages, one-shot reminders, discussions, protected
steering, recorded turn origins and receipts whose queue row is gone are not
coalesced. Pending turns, business obligations and UNKNOWN external effects are
not modified. This does not repair or replay uncertain execution.

## Shipping Replies: supported setup, not activated

An authorized human business manager can use a reviewed **Template** to create
one fresh Shipping Replies chat with its own conversation UUID, assistant and
native session, no inherited credentials/history/browser, and all copied routines
paused. Template instantiation starts no model turn. Review the template to remove
unwanted routines and retain only the intended shared CS skills. Check existing
bots first to avoid creating a duplicate. No bot was created by build 514.

“Inactive” here means no automatic work: the template creates an **active native
registration** with paused routines. A literally inactive registration cannot
save even a paused routine using the current API. Ordinary new-chat/handoff
creation posts a first message and starts a turn, so it is not a zero-turn staging
mechanism. Existing-chat business enrollment requires an actual owner-granted
exact-chat delegation, preview and apply; apply activates registration. Do not
impersonate a human or use another bot's enrollment/identity.

Before enabling replies, the source custodian must:

1. Provision a distinct OrderOps principal and credential for the exact new bot,
   delivered through the approved secret destination. Verify its own capability,
   source account, case access, leases and permitted send path. Native registration
   does not create credentials or grant customer-send authority.
2. Confirm the existing enabled event source belongs to the same business and
   that the source sender uses the installed signed webhook transport. The route
   is `POST /webhooks/bot-events/:source`, with a fresh Unix-seconds timestamp and
   HMAC-SHA256 of `timestamp + '.' + raw JSON`; never expose its secret.
3. Prepare one paused `customer.replied` routine bound to that exact source and
   conversation. Events require `id`, `type`, `ticket_id`, `occurred_at` and
   `assigned_bot` equal to the exact new conversation UUID. An unassigned reply is
   rejected; another bot's assignment does not route here. Distinct events remain
   distinct; identical source/event retries deduplicate.
4. Reconcile shipping-case ownership, current workers and overlapping polling
   through the original owners. Verify source-side activation and an authorized
   controlled routing test before enabling. `connection.test` returns zero queued
   and is insufficient evidence of assigned customer-reply routing.

The native route, signature handling and assigned-reply selection are covered by
simulation tests. No live Shipping Replies identity, credential provision, source
assignment, enrollment or end-to-end customer route was created or verified.
Those are exact setup prerequisites, not missing customer consent.

## Validation and deployment

Focused tests: 55 passed. Root typecheck, full `npm test`, and production build
passed. Full suite: 3,262 server tests passed (12 skipped), 966 web tests, 49
browser-manager tests and 29 installer tests. The shell's default Node 22 could not load
its Homebrew simdjson library; validation uses the repository-required installed
Node 24 via PATH, without changing system dependencies.

Before deployment, a read-only live count found four queued periodic candidates
and zero pending periodic wakeups. Candidates are not certified duplicates;
runtime provenance checks decide eligibility.

The supported root restart refreshed web and runner, then interrupted this chat
when runner exited. Read-only reconciliation confirmed both new processes and
healthy local endpoints; the original restart process was gone. The supported
restart script then refreshed only app-runner, terminal and browser-manager.
All five services are healthy and migration 0143 is installed. The public front
door returned HTTP 302 and the tunnel had four active edge connections; this is
not authenticated end-to-end chat or customer-delivery verification. The initial
live coalescing audit has zero rows; no production backlog removals are claimed.
No live source activation or customer effects were used as tests.

## Changed files

- [Producer](/Users/archerclawdington/veneer-os/server/src/botWorkflows/routines.ts)
- [Coalescing and provenance](/Users/archerclawdington/veneer-os/server/src/botWorkflows/periodicChecks.ts)
- [Queue and dispatch integration](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Wakeup batch guard](/Users/archerclawdington/veneer-os/server/src/scheduled/wakeups.ts)
- [Additive migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0143_periodic_routine_coalescing.sql)
- [Employee and agent guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Busy queue and backlog tests](/Users/archerclawdington/veneer-os/server/test/wakeups.test.ts)
- [Event routing and inactive setup tests](/Users/archerclawdington/veneer-os/server/test/botWorkflows.test.ts)
- [Guide delivery tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/routine-coalescing/build514.md)
