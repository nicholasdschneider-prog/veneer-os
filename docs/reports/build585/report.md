# Installed purchase runner startup acceptance — BUILD585

The installed BUILD582/BUILD584 modules passed isolated native startup acceptance on October 5, 2026 at 20:52:42Z. Signed GET readback reports `worker_started:true` only after an actual native conversation-manager turn starts from the actual scheduled-task scheduler. No application implementation, schema, authentication, capability definition or permanent fence was changed.

## Retained associations

| Association | Synthetic fixture UUID |
| --- | --- |
| Event | `5ccb632b-a23a-46b6-ab50-9de68295dc4c` |
| Batch | `0842f1b4-a8d1-43d0-8e2a-ae3c1fa78e96` |
| Run | `92b1116a-3ba1-4fdb-9d4d-a5a7f69d3222` |
| Conversation | `3026f9e8-18c9-476b-836b-fec6af524704` |
| Actual manager turn | `ea1f408d-19d8-498c-be8d-298596b9741b` |
| Persisted start time | `2026-10-05T20:52:42.179Z` |

The fixture opened a fresh isolated database and seeded synthetic source, task, team, project and owner records. An ephemeral HMAC key stayed in memory and was erased during cleanup. No existing credential was read. Every application import uses `server/dist`; the retained evidence records SHA-256 hashes of the installed DB, webhook, purchase-event, scheduler and conversation-manager modules.

The strict signed raw-body POST returned HTTP 200 and its immutable accepted receipt. Before dispatch, signed canonical-path GET returned pending/worker_started:false and the fixture database contained no worker-start row. `scheduler.tick()` then dispatched to the real `createConversationManager`; its actual `runTurn` invocation was captured by an in-process synthetic provider. No bus start was emitted by this script and no start association was preinserted.

The provider remained blocked while signed GET returned linked/running/worker_started:true. The receipt stayed identical. Readback run, batch, conversation, turn and timestamp matched `scheduled_task_runs`, `purchase_event_batches`, `purchase_worker_starts` and the captured invocation. A pending native turn also bound the same conversation and synthetic owner. Original event/order IDs and the BUILD584 per-order exception instruction reached actual startup.

Wrong-owner acknowledgment was rejected, receipt update was rejected as immutable, and bad-signature GET returned HTTP 401. After this readback, the synthetic worker's final task action called installed `recordPurchasePass` with its actual invocation conversation and current fixture owner, `{outcome:'clear',cursor:null}`. The provider then emitted completion; native persistence and signed GET showed completed with the same start association and immutable receipt. The persisted acknowledgment bound the same run/conversation. Receipt, delivery and acknowledgment all retained `purchase_authority:false`. A further scheduler tick produced no extra provider invocation.

This exercises the exact-worker binding inside the installed acknowledgment function with synthetic principal context, not live MCP authentication or real owner enrollment. The one synthetic provider invocation exercises native orchestration; it does not prove a paid provider CLI, original purchasing executor or public Cloudflare authentication.

## Scope and validation

The added executable script is [verify-purchase-runner-startup.mjs](/Users/archerclawdington/veneer-os/scripts/verify-purchase-runner-startup.mjs). Run from the root with Node 24:

```sh
node scripts/verify-purchase-runner-startup.mjs
```

Every invocation creates fresh isolated UUIDs/database and a separate evidence filename, preserving prior receipts. It never opens the live database, invokes the real purchasing task, starts a provider subscription, uses a portal, sends a message, purchases, changes source activation or calls native live run-now. The scheduler's stored trigger label is `manual`; startup here is the fixture scheduler's normal pending-purchase dispatch via `tick()`, not the live manual-run API.

An initial script assertion assumed pending_turns also stores a turn_id; that table stores conversation/actor instead. The assertion was corrected against current schema, while the actual turn binding remains asserted against purchase_worker_starts and provider invocation. The fresh succeeding fixture above passed.

Root typecheck and the full suite passed: server 3,441 passed/15 skipped, web 1,008 passed, installer 29 passed and browser manager 51 passed. Root build passed with the existing Vite bundle-size warning. All five installed module hashes were rechecked after the build and remained identical to the acceptance evidence. No service restart is required or performed: this is an isolated verification executable using already deployed modules. Public authenticated delivery, original-worker adoption, genuine source eligibility and acceptance remain the origin's gates. Source event activation remains OFF under origin custody; BUILD583 is separately owned. Existing global UNKNOWN, uncertain-launch and failed/unacknowledged-run fences and BUILD584 ordinary per-order exception semantics remain unchanged.

## Evidence

- [Signed readbacks, persisted associations, invocation and installed hashes](/Users/archerclawdington/veneer-os/docs/reports/build585/startup-a190dd4c-a68d-489d-aba2-748a133d08fb.json)
- [Typecheck](/Users/archerclawdington/veneer-os/docs/reports/build585/typecheck.log)
- [Full tests](/Users/archerclawdington/veneer-os/docs/reports/build585/tests.log)
- [Build](/Users/archerclawdington/veneer-os/docs/reports/build585/build.log)
- [Earlier BUILD584 deployment and adoption instructions](/Users/archerclawdington/veneer-os/docs/reports/build584/report.md)
