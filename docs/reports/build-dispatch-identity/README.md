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

## Deployment and exact recovery disposition

Code commit `767a96d` was pushed to origin/main and deployed with the root restart after the passing checks above. All five services reported healthy: web, runner, app-runner, terminal and browser-manager. Read-only web and browser-manager health endpoints returned HTTP200. No customer/provider actions or source enrollment occurred.

The rollout itself began on the old coordinator. Supported `review` returned active_adoption_ready=true for job300, origin6286, turn `bf04e51d-a0f1-4afe-b6dd-d20ad4714ac5`, timestamp `2026-09-24T16:37:53.024Z`. Supported `adopt_active` succeeded with request key `build300-active-adoption-v1`; job300 remained running under its original owner/scope. This binds its real current completion, with an immutable recovery audit, rather than inferring identity from its prompt.

Supported read-only reviews of both legacy jobs returned done_recovery_ready=false:

| Job | Origin | Exact turn | Expected finished_at | Stable recovery key |
|---|---|---|---|---|
|295|6209|05eeef6c-2a9b-485d-9634-e49aeb2e5efc|2026-09-24 16:04:27|build300-recover-295-v1|
|298|6240|05f1ea8f-ae93-46fc-bc73-31a8f964af4d|2026-09-24 16:13:51|build300-recover-298-v1|

A bounded read-only metadata check identified the concrete blocker: the original OO owner had one pending turn and zero queued messages. Its new native origin6292/turn `68b32da5-e5d4-4e43-892c-b6a11ac74836` started at `2026-09-24T16:39:07.102Z`. No contents were read. Neither295 nor298 was mutated, recovered or newly commissioned. Queue readback before review contained only running300.

Next authorized operation: after the original owner is idle, freshly list the queue and repeat review with the exact tuple/key above; call recover_done only if eligible. Recover295 first, retaining its original brief/owner. Recover298 only after295 is terminal and a fresh review confirms no pending/queued work or scope competitor. Do not bypass these conditions with a new job, raw status edit, interruption or changed key. Existing authorization covers these exact recoveries, but this receipt does not claim they occurred.
