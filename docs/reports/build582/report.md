# Native Lippert purchase candidate receiver — BUILD582

Native technical implementation for origin chat `b8588128-bd03-423d-acfe-61ef8fc94a1c`, under Veneer project `dc6e8855-584a-4945-8bc0-718780ae767f`. Implemented and deployed on October 5, 2026. The exact binding migration is applied with a matching content hash, and all services are healthy. Source activation remains with the origin.

## Behavior

The receiver accepts only the strict frozen `lippert.purchase_candidate/v1` payload through the existing source-specific exact-raw-body HMAC boundary (16 KiB, timestamp ±300 seconds). Canonical sorted-key SHA256 matches the current source's shared `digest` for this flat payload. Individual immutable receipts preserve every event identity and conflict on a changed payload. Delayed/out-of-order hints do not overwrite source order state. Future occurrence times beyond five minutes are rejected.

Signed GET uses `/webhooks/bot-events/:source/purchase-events/:eventId` and `timestamp + ".GET." + canonical pathname`; queries, alternate encoded paths and wrong signatures are refused. Readback separates the immutable receipt from mutable delivery/run/start status. Current source/team/task/owner/project authorization is checked at intake, dispatch, runner entry and readback. Revocation fails closed, including retained GET (403), rather than returning an old authorization.

The migration narrowly binds the existing source `90ef6920-4bbd-4bb9-852d-02868dd8b05b`, team `5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86`, owner 1 and existing purchasing task `9c72a42a-40df-4477-9ba6-07f74ac08bf3` in ERVP project `e8e0efc6-2f5f-4666-8588-ede17529bc9c`. It creates no task, credentials or source enrollment. Projects have no separate user-membership table; task ownership and exact project existence are verified. The team's owner has access directly, without a redundant member row.

Event, cron and manual task dispatch share an immediate SQLite transaction and the existing active-run exclusion (`queued`, `running`, `needs_you`). Each run seals at most eight distinct hinted orders; other accepted IDs remain in one pending successor. Pending intake is bounded to 256 events; overflow is rejected without a receipt or dispatch. The source's daily backup remains responsible for unhinted/missed backlog. Event IDs, order IDs and revisions enter the actual task prompt as reference data, never instructions or purchase approval.

Run/batch associations persist before `postMessage`. `worker_started` becomes true only from the actual native conversation manager's turn-start event and a durable run/conversation/turn association. A timer, successful POST or `running` flag does not set it. Interrupted purchase prompts are retained as failed evidence; both scheduler recovery and the conversation manager prevent automatic replay of fenced work. No recovery/retry/reset endpoint is added.

Automatic successor dispatch additionally requires an immutable `record_purchase_candidate_pass` acknowledgment from the authenticated exact current worker, plus a successful started turn. The worker reports `clear` only after fresh source reads establish that its pass can safely continue, otherwise `blocked` or `unknown`; it retains only a nonsecret queue cursor. A missing acknowledgment also fences continuation. This is a scheduling statement by the original executor, not backend verification of source eligibility or purchasing consent. The stored task prompt, model, effort, owner and cron remain unchanged; the native runtime wrapper explains this new tool. Unresolved native questions retain active exclusion.

## Boundaries and acceptance

Source transport remains disabled. Only the origin coordinates source activation after native acceptance and original-worker safe-read validation, including adoption of the pass acknowledgment. Public Cloudflare Access reachability using the original sender credentials is not tested by this builder. No new credentials or policy enrollment is supplied.

The retained deployed fixture uses a separate synthetic database/source/task and the installed `server/dist` receiver modules. It proves authenticated intake/readback of a retained receipt without starting an agent. The real manager startup tests use a synthetic provider only. Neither proves a live purchasing worker start, current source eligibility or any supplier acceptance. No real purchase event, task run-now, portal operation, customer/vendor message or business mutation test was performed.

All source-owned per-order/shared-portal claims, fresh revision/before-submit checks and permanent purchase fences remain mandatory. Historical #100121726 and decision 0a9dd689 v1 are untouched. The source checkout was read only (observed HEAD `271daa867567375065f9492af4a43fe1f0138852`). Shipment tracking BUILD557 and its separate task are unchanged.

## Validation and evidence

Typecheck, the final full suite and production build passed: server 3,438 tests (15 skipped), web 1,008 tests, installer 29 tests and browser-manager 51 tests. The build emitted only its bundle-size warning. Focused validation passed 50 checks, including 13 purchase tests, the real manager with a synthetic provider, HTTP caller binding, actual MCP tool mapping and guide delivery.

One initial full run failed while deleting a synthetic Codex test directory (`ENOTEMPTY`). The isolated recheck passed, and the later full run passed. The test was not weakened or changed.

- [Binding and unchanged-task fingerprints before deployment](/Users/archerclawdington/veneer-os/docs/reports/build582/native-binding-before.json)
- [Final full test log](/Users/archerclawdington/veneer-os/docs/reports/build582/tests.log)
- [Typecheck log](/Users/archerclawdington/veneer-os/docs/reports/build582/typecheck.log)
- [Focused validation](/Users/archerclawdington/veneer-os/docs/reports/build582/focused-tests.log)
- [Initial full-run cleanup failure](/Users/archerclawdington/veneer-os/docs/reports/build582/first-full-tests.log)
- [Cleanup recheck](/Users/archerclawdington/veneer-os/docs/reports/build582/cleanup-recheck.log)
- [Full validation before the final pass guard](/Users/archerclawdington/veneer-os/docs/reports/build582/pre-ack-full-tests.log)

The resumed native chat also discovers the installed `record_purchase_candidate_pass` MCP tool without calling it. The employee guide and fresh/resumed agent instruction catalog document the receiver, activation boundary and worker-pass tool: [Lippert candidate delivery guide](/#/bot-guide?feature=lippert-purchase-events). The existing catalog/role/instruction tests cover its delivery; no UI layout or employee access policy changed.

## Deployment evidence

The first root restart completed web and runner restarts before interrupting this build turn. Fresh pid/start-time and health checks confirmed both restarted. The remaining app-runner, terminal and browser-manager services were then restarted with `npm run restart -- veneer-pro-app-runner veneer-pro-term veneer-browser-manager`; neither web nor runner was repeated. All services are healthy. Tunnel/front-door checks are reachable but do not prove authenticated public sender access.

The applied migration hash matches the verified source. Purchasing and tracking configuration/prompt fingerprints match before deployment; the live database contains zero purchase candidate receipts and no purchasing run since the restart. A harmless live GET with a synthetic source/event and invalid signature returns 401, confirming the installed route rejects unauthorized readback. The isolated installed-module fixture returns authenticated POST 200 / retained GET 200 / bad-signature GET 401. Its receipt remains pending with no worker startup.

- [Applied migration, running processes and live read-only signature rejection](/Users/archerclawdington/veneer-os/docs/reports/build582/deployment.json)
- [Installed-module authenticated retained receipt](/Users/archerclawdington/veneer-os/docs/reports/build582/deployed-fixture.json)
- [Binding and unchanged-task fingerprints after deployment](/Users/archerclawdington/veneer-os/docs/reports/build582/native-binding-after.json)
- [Retained isolated fixture database](/Users/archerclawdington/veneer-os/out/build582/8774a23a-f313-4643-9a1d-9cf428143d74/veneer-pro.db)
- [Build log](/Users/archerclawdington/veneer-os/docs/reports/build582/build.log)
- [Initial restart log](/Users/archerclawdington/veneer-os/docs/reports/build582/restart.log)
- [Remaining services restart and health](/Users/archerclawdington/veneer-os/docs/reports/build582/restart-remaining.log)
- [Read-only health check](/Users/archerclawdington/veneer-os/docs/reports/build582/health.log)

## Changed source and fixture files

- [Purchase receipt, authorization and pass service](/Users/archerclawdington/veneer-os/server/src/botWorkflows/purchaseEvents.ts)
- [Signed webhook routes](/Users/archerclawdington/veneer-os/server/src/botWorkflows/routes.ts)
- [Immutable persistence and narrow binding migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0150_purchase_candidate_events.sql)
- [Scheduler fencing, coalescing and start associations](/Users/archerclawdington/veneer-os/server/src/scheduled/scheduler.ts)
- [Native runner replay guard](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Exact-worker pass API](/Users/archerclawdington/veneer-os/server/src/routes/scheduledTasks.ts)
- [Worker pass MCP tool](/Users/archerclawdington/veneer-os/server/src/mcp/agentToolsServer.ts)
- [Employee and agent capability guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Purchase fixture tests](/Users/archerclawdington/veneer-os/server/test/purchaseEvents.test.ts)
- [MCP tool validation](/Users/archerclawdington/veneer-os/server/test/agentScheduledTaskTools.test.ts)
- [Installed-module retained receiver fixture](/Users/archerclawdington/veneer-os/scripts/verify-purchase-event-receiver.mjs)
