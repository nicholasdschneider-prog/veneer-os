# Purchase-pass exceptions and independent successors — BUILD584

Native follow-up to BUILD582 for origin `b8588128-bd03-423d-acfe-61ef8fc94a1c`, deployed October 5, 2026 after validation and the fresh custody check below. This change clarifies scheduling evidence; it grants no purchasing, portal, credential or financial authority.

## Exact worker adoption

Call `record_purchase_candidate_pass` as the **final task action before completion**, with:

```json
{"outcome":"clear","cursor":null}
```

`outcome` is exactly `clear`, `blocked` or `unknown`. The optional cursor defaults to null and accepts null or a nonsecret string of at most 500 characters. Customer bodies and credentials do not belong in this field. The authenticated original worker must have the exact active running scheduled run, a persisted actual worker-start association, and current source/task/owner binding. The acknowledgment remains immutable: identical outcome/cursor repeats are idempotent; changed values conflict. Every result has `purchase_authority:false`.

- **clear:** a successful fresh finite queue pass. Grounded per-order cost, address or decision exceptions can be safely skipped while unrelated eligible orders remain processable. This does not approve the skipped order, remove its source fence or claim that every order was purchased.
- **blocked:** a task/global block preventing safe continuation.
- **unknown:** task/global UNKNOWN or uncertain portal/launch. Never retry, rekey or replay that work.

Failed, missing-start and unacknowledged runs retain their existing fences. A clear acknowledgment plus successful actual turn completion permits only a bounded pending successor. Replaying an already accepted blocked-only event identity does not create another run. This fixture proves exact-event replay suppression; source BUILD583 remains responsible for source-level revision coalescing and genuine eligibility. No broader deduplication of distinct new source events was introduced.

The backend already accepts a clear scheduling statement independently of per-order exceptions, so no backend, schema, authentication, receipt or acknowledgment persistence change was necessary. Existing immutable records were not rewritten. The changes are limited to the scheduler startup/reference instructions, MCP description, capability guide and synthetic fixtures.

## Validation

Focused validation passed 53 tests: 16 purchase fixtures, six native MCP checks and 31 guide checks. The new fixture models a grounded ordinary cost exception, records a clear finite pass, dispatches a different eligible later hint in the bounded successor, and replays the original blocked-only event ten times without another dispatch. Receipt and acknowledgment authority remain false. Coverage also retains both permanent global `SOURCE_BLOCKED` and `SOURCE_UNKNOWN`, exact-worker authentication, missing acknowledgment/start failures and unchanged/conflicting acknowledgment inputs.

An initial full suite run failed on `ENOTEMPTY` while deleting a synthetic Codex test directory. Its isolated recheck passed. The failure evidence is retained; no assertion or production code was weakened to bypass it. Root typecheck, the full rerun and root build all passed: server 3,441 passed/15 skipped, web 1,008 passed, installer 29 passed, browser manager 51 passed. Build emitted the existing Vite bundle-size warning.

## Installed deployment verification

The root restart replaced web and runner at 20:47Z. Restarting the runner interrupted its owning provider turn before the remaining services, so after resume the same root restart script was invoked only for app-runner, terminal and browser manager; all completed at 20:49Z. Local web/runner and browser-manager health passed. The public front door returned HTTP 302 and the tunnel had four active connections; authenticated public end-to-end chat delivery is not proven by those checks.

Installed compiled catalog, resumed-agent instructions, scheduler startup and MCP definition all contain the clarification. The resumed native MCP tool metadata also exposes the updated definition. Compiled file hashes and service process start times are retained in deployment.json. Verification used synthetic fixtures and read-only installed artifacts; no live purchasing task or pass acknowledgment was invoked.

## Fresh original-worker custody

Original run `6c86f966-ea62-4bb4-937c-87351d19b279`, chat `d7020a1f-ae60-4eff-8fc1-3d09b9c4a403`, remains completed at 20:15:04Z. Initial native readback showed no active purchasing run and no pending/queued prompt. The original worker completed a separate read-only custody check in coordination `7e331676-28ae-461e-a18b-136c591e2cc1`, final 20:43:07Z/status idle, and the origin was sent its findings.

The worker reports its own existing-principal OrderOps GETs at 20:42:21–20:42:33Z verified both original purchase attempts have canonical supplier confirmations and completed writebacks, with no unconfirmed attempt from that run. Ordinary skipped orders have no purchase attempts. It reports all four original claims released; tokens are expired. There is no claim-status GET, so the no-claim conclusion is limited to its original release report and current eligibility/no-conflict facts.

Its browser was stopped before the check. The reopened original profile redirected the cart URL to login, so **there is no fresh authenticated cart inspection**. It did not sign in, change/purge a cart or update the saved profile, and stopped the temporary copy again (0/7 browser slots). The last cart-clear evidence is the original run's report. It reports nothing from the original run in flight and is no longer working. Native state is rechecked immediately before restart; no active Place or uncertain writeback is intentionally interrupted.

## Source and financial boundaries

Source BUILD583 is owned elsewhere. Event activation remains OFF until native acceptance, original-worker adoption and authenticated source/start checks. This builder performed no live task run-now, financial test, portal operation, credential borrowing, claim/release/writeback, customer/vendor send or ERVP edit.

The user's separate baseline instruction is **prospective only**: absent an established ground baseline, use genuine current Shopify customer-paid shipping for a wholly Lippert order. An unknown mixed-route allocation goes to Sage. This is not retroactive authority for prior purchases, and this native patch does not implement or validate the source's shipping-baseline mechanics. Existing purchase fences and historical UNKNOWN outcomes remain unchanged.

## Files and retained evidence

- [Scheduler startup and reference clarification](/Users/archerclawdington/veneer-os/server/src/scheduled/scheduler.ts)
- [Exact MCP definition](/Users/archerclawdington/veneer-os/server/src/mcp/agentToolsServer.ts)
- [Employee and resumed-agent guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Synthetic successor and fence fixtures](/Users/archerclawdington/veneer-os/server/test/purchaseEvents.test.ts)
- [Focused tests](/Users/archerclawdington/veneer-os/docs/reports/build584/focused.log)
- [Typecheck](/Users/archerclawdington/veneer-os/docs/reports/build584/typecheck.log)
- [Final full suite](/Users/archerclawdington/veneer-os/docs/reports/build584/tests.log)
- [Initial cleanup failure](/Users/archerclawdington/veneer-os/docs/reports/build584/first-tests.log)
- [Cleanup recheck](/Users/archerclawdington/veneer-os/docs/reports/build584/cleanup-recheck.log)
- [Build](/Users/archerclawdington/veneer-os/docs/reports/build584/build.log)
- [Fresh native custody readback](/Users/archerclawdington/veneer-os/docs/reports/build584/custody-before-restart.json)
- [Initial root restart](/Users/archerclawdington/veneer-os/docs/reports/build584/restart.log)
- [Remaining services and health](/Users/archerclawdington/veneer-os/docs/reports/build584/restart-remaining.log)
- [Installed deployment evidence](/Users/archerclawdington/veneer-os/docs/reports/build584/deployment.json)

Employee guide: [Lippert candidate delivery](/#/bot-guide?feature=lippert-purchase-events). The existing guide role/catalog/instruction tests cover unchanged employee access and fresh/resumed instruction delivery.
