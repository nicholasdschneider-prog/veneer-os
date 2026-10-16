# Hermes Phase 2 — execution checkpoint

Authority: Nick’s October 16 SSH stop approval in chat fce19860, followed by the explicit GO list in this coordination thread. No Hermes job was invoked. No files were deleted. Held jobs, gateways, and Tier C items remain unchanged.

## Item status

| Item | State | Evidence / next step |
| --- | --- | --- |
| 1 Completion Mirror | Verified disabled | Disabled 08:39:15 ET. No in-flight process. Observed through 08:44:30 ET, covering a full five-minute cycle; last run stayed 08:35:15 ET, no relaunch. Shared ledger preserved; All Order Review remains its held writer. |
| 2 Brent and Brady / Tim gateway | Verified retired | Both watcher cron entries stayed disabled with unchanged last-run times/execution IDs and zero ALL unfinished executions through 09:28 ET. Both cursor files remain absent. Watchdog disabled 08:51:54 ET, active launcher renamed with original SHA-256 preserved, exact gateway stopped 08:51:55 ET. Final 09:27:58 ET observation passed all checks after 2,162 seconds: no relaunch, watchdog last run unchanged, active launcher absent, disabled launcher hash unchanged. |
| 3 Inventory sync incident router | Verified disabled | Disabled 09:28:55 ET. At 09:37:27 ET the full five-minute observation passed: disabled flag, last-run time, execution IDs and all local state hashes/mtimes unchanged, zero ALL unfinished executions. No local incident/claim delta. Local log remains historical failure evidence, not an authoritative remote incident count; do not claim zero remote incidents. |
| 4 Dometic SO/manual reply watches | Verified disabled | Final 10:38:22–23 ET checks passed after 3,625 seconds: both disabled, last-run times/execution IDs unchanged, zero ALL unfinished executions. No changes to three state file hashes, per-field hashes, safe reported IDs or fingerprints. SO retains one reported message ID; technical incident remains resolved; manual fingerprints retained for both orders. Safe final receipt sent to coordinator before Sage’s 11:00 ET custody. |
| 5 Martine Reply Watcher | Verified disabled | Full-hour observation passed at 11:39 ET: disabled, same June 20 last-run field, zero recorded/unfinished executions, no matching helper process, script hash unchanged and no retained local reply cursor. No helper invocation or mailbox query was performed; no assertion about new mailbox replies. |
| 6 Accounting Inbox Read-Only Monitor | Disabled; business-cycle observation pending | accounting-migration2ecec57ee69b disabled 11:40:24.306054 ET under scheduler lock; no unfinished execution. Preserved/fingerprinted 36 accounting state/processed artifacts. Next eligible trigger is Friday 12:07 ET; wait through a full 30 minutes to 12:10:24 ET, then check unchanged execution IDs/state before item 7. |
| 7–9 | Not yet changed | Continue serially after item 6 observation passes. |

## PC-only archive

The recovery baseline remains on the PC at `C:\Users\nicho\backups\hermes-final-20261016`. The six-root copy phase has finished; the original WMI controller PID 19500 (created 08:47:43 ET) is hashing the archive. At 11:39 ET its status reported 450,000 files hashed, 32,427,084,969 bytes, and 1,798 accumulated errors. Hashing remains in progress; the detailed error list will be emitted on completion. The archive is NOT verified. A bounded 20-second long-path sample checked 454,105 entries without finding a diagnostic candidate; this does not establish the cause of hashing errors. All **199/199 consistent SQLite snapshots passed integrity_check**; no database error metadata was returned. Per-file manifest hashing, restore sample and ACL verification are still pending. No archive data is copied to this Mac.

The separately identified initial copy error is **services/dashboard/supervisor.lock**, a 37-byte file held open by the dashboard (Robocopy error 33/retry limit). No retry or premature process stop was performed. Keep the archive unverified until both this copy issue and all hashing errors are reconciled. After the approved item 8 dashboard stop and observation, preserve this now-unlocked file on the PC, reconcile its hash with the archive/manifest and rerun appropriate artifact-only checks; do not rerun Hermes. Wait until the archive controller completes before changing its destination tree.

The initial SSH-child launch exited when its SSH session ended; its unverified directory was preserved under `hermes-final-20261016.incomplete-0847`. Review also found auth/config backup filename variants, so exclusions were broadened and checked before the WMI launch. No secret values were read or displayed. The incomplete directory is retained, not a usable recovery archive.

The archive will remain a **baseline**, not a final quiescent seal, while held writers are active. Credentials/configuration are excluded by metadata; retain original PC/account custody and reauthenticate for recovery. Reparse targets are inventoried rather than blindly traversed.

## Continuation

At the next wake at 12:11:00 ET, read accounting-migration2ecec57ee69b using make-cron-probe.py read mode. Require disabled, unchanged last_run_at/execution IDs, zero ALL unfinished executions, elapsed >=1,800 seconds since 15:40:24.306054Z, and passage of its eligible Friday 12:07 ET trigger. Re-run item06-state.ps1; compare all source file hashes/mtime and per-field status fingerprints against item06-state-disabled.json, preserving original processed-state files. After item 6 passes, handle conditional item 7, then dashboard item 8 and idle gateways item 9 in original serial order.

Items 1–5 are verified complete; do not repeat disables/stops. HOLD and Tier C enabled states were revalidated unchanged after item 6. The coordinator was notified of Martine completion, accounting disable and the increased archive error count. No application source, build, restart, mailbox query, business job or deletion is authorized here.

Check the archive controller’s exact identity and current status. If finished, inspect verification.json/error metadata first; do not retry or overwrite the archive blindly. Diagnose/reconcile missing or unreadable artifact files locally on the PC. The known supervisor.lock file stays locked until the approved item 8 stop. After that stop/observation AND controller completion, preserve it and reconcile the manifest. Keep brain backup/vault holds and do not claim a final quiescent seal while held writers remain live. Persist every pending observation/archive wake.

Item 7 still requires proof of no unique pending downstream-consumed output. The broad six-root read-only source scan timed out after 240 seconds without a completed report. Its exact leftover Python probe was identified by PID, creation time and SHA-256 of its decoded source, then stopped; the archive and business processes were not targeted. Do not use the incomplete scan as consumer-absence proof. Use a bounded audit of active task/cron script dependencies later, or report/skip item 7 if the prerequisite cannot be established.

Keep the original full GO/HOLD list and never run business scripts or delete files. No application source changes, build or production restart are involved. Send complete items1–9 results to fce19860 using request_key `hermes-pc-operator-phase2`, with a separate archive verification report when actually verified.

## Artifacts

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/SHA256SUMS.txt)
- [archive-and-probe-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-and-probe-status.json)
- [archive-and-probe-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-and-probe-status.ps1)
- [archive-error-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-error-review.json)
- [archive-error-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-error-review.ps1)
- [archive-launch-command.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-command.ps1)
- [archive-launch-wmi.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-wmi.ps1)
- [archive-locked-path-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-locked-path-review.json)
- [archive-locked-path-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-locked-path-review.ps1)
- [archive-path-diagnostic.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-path-diagnostic.json)
- [archive-path-diagnostic.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-path-diagnostic.ps1)
- [archive-pause-exclusions.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.json)
- [archive-pause-exclusions.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.ps1)
- [archive-pc.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pc.py)
- [archive-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.json)
- [archive-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.ps1)
- [archive-progress-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-progress-0953.json)
- [archive-start-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start-wmi.json)
- [archive-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start.json)
- [archive-status-0850.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-0850.json)
- [archive-status-0928.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-0928.json)
- [archive-status-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-0953.json)
- [archive-status-item04-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-item04-start.json)
- [archive-status-item05-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-item05-start.json)
- [archive-status-item06-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-item06-start.json)
- [archive-status-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-wmi.json)
- [archive-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.json)
- [archive-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.ps1)
- [audit-drift.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/audit-drift.py)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/cron-control.py)
- [current-inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/current-inventory.json)
- [discover-runtime.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.json)
- [discover-runtime.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.ps1)
- [drift-0954.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-0954.json)
- [drift-after-item04.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-after-item04.json)
- [drift-after-item05.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-after-item05.json)
- [drift-after-item06.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-after-item06.json)
- [drift-check-after-item03.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-item03.json)
- [drift-check-after-tim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-tim.json)
- [drift-item06-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-item06-start.json)
- [inventory-0954.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-0954.json)
- [inventory-after-item03-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item03-disable.json)
- [inventory-after-item04-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item04-disable.json)
- [inventory-after-item05-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item05-disable.json)
- [inventory-after-item06-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item06-disable.json)
- [inventory-after-tim-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-tim-stop.json)
- [inventory-item06-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-item06-start.json)
- [item01-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.json)
- [item01-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.ps1)
- [item01-observe-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe-final.json)
- [item01-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.json)
- [item01-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.ps1)
- [item02-brady-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.json)
- [item02-brady-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.ps1)
- [item02-brady-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-final.json)
- [item02-brady-final.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-final.ps1)
- [item02-brady-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-observe.json)
- [item02-brady-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-observe.ps1)
- [item02-brent-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.json)
- [item02-brent-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.ps1)
- [item02-brent-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-final.json)
- [item02-brent-final.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-final.ps1)
- [item02-brent-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-observe.json)
- [item02-brent-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-observe.ps1)
- [item02-gateway-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-final.json)
- [item02-gateway-interim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-interim.json)
- [item02-gateway-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-observe.ps1)
- [item02-gateway-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-preflight.json)
- [item02-gateway-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-preflight.ps1)
- [item02-gateway-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-stop.json)
- [item02-gateway-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-stop.ps1)
- [item02-state-after-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-after-observation.json)
- [item02-state-before-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-before-observation.json)
- [item02-state-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-final.json)
- [item02-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state.ps1)
- [item02-watchers-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-watchers-confirmed.json)
- [item03-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-before.json)
- [item03-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-before.ps1)
- [item03-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-confirmed.json)
- [item03-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-disable.json)
- [item03-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-disable.ps1)
- [item03-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-observe.json)
- [item03-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-observe.ps1)
- [item03-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-disabled.json)
- [item03-state-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-final.json)
- [item03-state-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-review.json)
- [item03-state-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-review.ps1)
- [item03-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state.ps1)
- [item04-checkpoint-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-checkpoint-0953.json)
- [item04-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-confirmed.json)
- [item04-manual-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-before.json)
- [item04-manual-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-before.ps1)
- [item04-manual-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-disable.json)
- [item04-manual-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-disable.ps1)
- [item04-manual-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-final.json)
- [item04-manual-final.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-final.ps1)
- [item04-manual-observe-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-observe-0953.json)
- [item04-manual-observe-0953.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-observe-0953.ps1)
- [item04-so-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-before.json)
- [item04-so-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-before.ps1)
- [item04-so-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-disable.json)
- [item04-so-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-disable.ps1)
- [item04-so-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-final.json)
- [item04-so-final.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-final.ps1)
- [item04-so-observe-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-observe-0953.json)
- [item04-so-observe-0953.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-observe-0953.ps1)
- [item04-state-0953.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state-0953.json)
- [item04-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state-disabled.json)
- [item04-state-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state-final.json)
- [item04-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state.ps1)
- [item05-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-before.json)
- [item05-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-before.ps1)
- [item05-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-confirmed.json)
- [item05-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-disable.json)
- [item05-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-disable.ps1)
- [item05-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-final.json)
- [item05-final.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-final.ps1)
- [item05-no-inflight-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-no-inflight-confirmed.json)
- [item05-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-state-disabled.json)
- [item05-state-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-state-final.json)
- [item05-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item05-state.ps1)
- [item06-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-before.json)
- [item06-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-before.ps1)
- [item06-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-disable.json)
- [item06-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-disable.ps1)
- [item06-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-state-disabled.json)
- [item06-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item06-state.ps1)
- [make-cron-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/make-cron-probe.py)
- [martine-path-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/martine-path-review.json)
- [martine-path-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/martine-path-review.ps1)
- [martine-state-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/martine-state-discovery.json)
- [martine-state-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/martine-state-discovery.ps1)
- [mirror-ledger-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.json)
- [mirror-ledger-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.ps1)
- [next-state-source-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/next-state-source-review.json)
- [next-state-source-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/next-state-source-review.ps1)
- [review-targets.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.json)
- [review-targets.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.ps1)
- [router-path-and-archive-progress.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/router-path-and-archive-progress.json)
- [router-path-and-archive-progress.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/router-path-and-archive-progress.ps1)
- [run-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/run-probe.py)
- [shadow-and-router-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/shadow-and-router-review.json)
- [shadow-and-router-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/shadow-and-router-review.ps1)
- [shadow-consumer-audit-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/shadow-consumer-audit-status.json)
- [shadow-consumer-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/shadow-consumer-audit.ps1)
- [source-lock-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.json)
- [source-lock-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.ps1)
- [start-archive.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/start-archive.ps1)
- [state-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.json)
- [state-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.ps1)
- [stop-timedout-own-scan.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/stop-timedout-own-scan.json)
- [stop-timedout-own-scan.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/stop-timedout-own-scan.ps1)
- [tim-state-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.json)
- [tim-state-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.ps1)
