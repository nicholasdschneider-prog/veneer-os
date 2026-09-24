# Exact build activation identity — BUILD300

## Repair

The prior coordinator selected a running job by conversation for `turn_done` and revived stopped jobs on any `turn_started`. That source mechanism could release a delayed build on an unrelated conversation turn. The retained295/298 timestamp/origin observations are compatible with that mechanism, but the historical callback trace was not recorded; this release does not manufacture one.

Each new dispatch now has a generated durable ID stored on the job and in `build_dispatches`. It is carried in the manager's internal `MessageOrigin.buildDispatchId` and persisted with the queued/pending prompt. The manager uses a stable `build:<dispatch_id>` inbound receipt, making repeated dispatch delivery idempotent. The coordinator binds only a manager-emitted start whose exact dispatch ID also exists in persisted `turn_origins`. A newer persisted origin advances the current turn after restart; an old start cannot move it backward.

Completion/error applies only to the current exact turn of that active dispatch. Unrelated turn completion, untagged diagnostics and conversation status do not resolve the build. Transition/audit writes serialize in an immediate transaction. Diagnostics receive the actual runtime turn ID. Failed/timed-out matching turns retain the existing bounded retry policy; explicit completed outcome remains authoritative. Stop parks the job; follow-up discussion alone no longer revives it. Use supported retry/skip to resume or release it. Retry drops only an exact failed pending row from that job's old dispatch; unrelated work is preserved. Stale queued build activations cannot execute after their dispatch loses ownership.

Startup retains an exact queued/pending activation, otherwise visibly pauses a phantom rather than blindly dispatching again. A pre-upgrade running build has no dispatch ID and cannot be completed by an untagged callback. The current same-owner rollout turn can explicitly adopt its exact persisted origin through the audited path below; there is no automatic prompt-text inference or migration backfill.

## Supported recovery contract

Tool: `recover_build_queue`; authenticated route: `POST /api/build-queue/recover`.

Fields:
- `job_id`: original numeric job
- `origin_id`: exact native `turn_origins.id`
- `turn_id`: exact UUID paired with that row
- `expected_finished_at`: exact observed job timestamp, or null for current active rollout adoption
- `request_key`: stable recovery key, never a new key to evade a conflict
- `mode`: `review`, `recover_done`, or restricted `adopt_active`
- `reason`: explicit operator-reviewed evidence/authorization,10–2000 characters

Use **review first**. The route requires existing management access; the coordinator independently requires the original active native owner and unchanged owning conversation. Legacy origin must be exact same conversation, actual build_queue provenance and exact turn ID. Original job must have no existing new dispatch identity. No prompt/body is used to infer job linkage. Because old dispatches did not record a job ID, the job/origin pair is explicitly operator-selected and audited under the user's authorization—not represented as a recovered historical callback signature.

`recover_done` additionally requires actual done status, source turn later than the recorded completion, unchanged expected finish timestamp, no live turn/pending turn/queued messages for the original owner, and no other queued/running/failed/stopped build in its scope or conversation. It snapshots the unchanged original job and selected origin/request in immutable `build_recoveries`, then requeues the SAME job/brief/owner. Normal queue dispatch, not a manual source commission, resumes it. Recovery is transactional; identical retries return the same existing recovery disposition, conflicting keys deny. Never reopen completed business actions merely because the original build was prematurely closed.

`adopt_active` is only the calling chat's current pre-upgrade running build: exact latest origin, matching durable pending origin and actor, currently live and no queued work. It records an audited dispatch for this actual turn and tags pending state for future restart. It cannot adopt another chat, historical completion or arbitrary follow-up.

`review` is read-only and does not tick/dispatch the queue. Recovery returns minimal IDs/status, not protected chat contents. Audit preserves original brief/history internally. No raw database status rewrite is a supported operation.

## Incident application limits

295 and298 share the same original OrderOps owner and scope. Recovering one occupies that scope; the second cannot be simultaneously recovered. Fresh state/owner/pending-turn/dedupe review must precede each mutation. A busy or competing scope is a concrete blocker, not permission to create a replacement job. No new source executor, provider/customer action, source registration, model change or historical business replay is authorized by this repair.

## Files

- [Coordinator](/Users/archerclawdington/veneer-os/server/src/buildQueue/coordinator.ts)
- [Audited recovery](/Users/archerclawdington/veneer-os/server/src/buildQueue/recovery.ts)
- [Dispatch and audit schema](/Users/archerclawdington/veneer-os/server/src/db/migrations/0122_build_dispatch_identity.sql)
- [Runtime durable origin and dispatch](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Event types](/Users/archerclawdington/veneer-os/server/src/runtime/events.ts)
- [Authenticated recovery route](/Users/archerclawdington/veneer-os/server/src/routes/buildQueue.ts)
- [Runner client](/Users/archerclawdington/veneer-os/server/src/runner/client.ts)
- [Runner RPC](/Users/archerclawdington/veneer-os/server/src/runner/ipcServer.ts)
- [Supported bot tool](/Users/archerclawdington/veneer-os/server/src/mcp/agentToolsServer.ts)
- [Living guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Existing queue regressions](/Users/archerclawdington/veneer-os/server/test/buildQueue.test.ts)
- [Exact identity/recovery/race fixtures](/Users/archerclawdington/veneer-os/server/test/buildDispatchIdentity.test.ts)

## Validation

Root typecheck/full npm test/build passed: server2,447 passed/5 existing skipped, web880, browser-manager40, installer21. The final additional real-manager ordering fixture also passed with all8 identity tests: a build queued behind unrelated work is bound only when its own turn starts and only its completion releases the slot. Synthetic tests cover exact295/298 ordering shapes, delayedactivation, unrelated status/errors/completions, newer restart turn vs old callback, stop/explicitretry, originalowner/stale/queued recovery denial, immutable audit, idempotency and real competing SQLite writers. Full/restricted guide browser checks and resumed instruction/catalog tests passed. Existing bundle-size advisory remains.
