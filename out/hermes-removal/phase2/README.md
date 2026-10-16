# Hermes Phase 2 — execution checkpoint

Authority: Nick’s October 16 SSH stop approval in chat fce19860, followed by the explicit GO list in this coordination thread. No Hermes job was invoked. No files were deleted. Held jobs, gateways, and Tier C items remain unchanged.

## Item status

| Item | State | Evidence / next step |
| --- | --- | --- |
| 1 Completion Mirror | Verified disabled | Disabled 08:39:15 ET. No in-flight process. Observed through 08:44:30 ET, covering a full five-minute cycle; last run stayed 08:35:15 ET, no relaunch. Shared ledger preserved; All Order Review remains its held writer. |
| 2 Brent and Brady / Tim gateway | Verified retired | Both watcher cron entries stayed disabled with unchanged last-run times/execution IDs and zero ALL unfinished executions through 09:28 ET. Both cursor files remain absent. Watchdog disabled 08:51:54 ET, active launcher renamed with original SHA-256 preserved, exact gateway stopped 08:51:55 ET. Final 09:27:58 ET observation passed all checks after 2,162 seconds: no relaunch, watchdog last run unchanged, active launcher absent, disabled launcher hash unchanged. |
| 3 Inventory sync incident router | Verified disabled | Disabled 09:28:55 ET. At 09:37:27 ET the full five-minute observation passed: disabled flag, last-run time, execution IDs and all local state hashes/mtimes unchanged, zero ALL unfinished executions. No local incident/claim delta. Local log remains historical failure evidence, not an authoritative remote incident count; do not claim zero remote incidents. |
| 4 Dometic SO/manual reply watches | Disabled; hourly observation pending | SO 330388e25e93 disabled 09:37:57 ET (60-minute interval); manual 305da2ff8a02 disabled 09:37:58 ET (15-minute interval). No unfinished execution for either. All three named state files captured by metadata, safe IDs, per-field hashes and whole-file hashes; customer bodies remain on PC. SO has one reported message ID, technical incident status resolved, manual fingerprints retained for both orders. Check manual after 09:52:58 ET; require SO full hour after 10:37:57 ET before item 5. |
| 5–9 | Not yet changed | Continue serially after item 4 completes. |

## PC-only archive

The running recovery baseline is `C:\Users\nicho\backups\hermes-final-20261016`, launched through Windows WMI at 08:47:43 ET. A separate SSH check confirmed both controller PID 19500 and its Robocopy child PID 18796 survived the SSH session. At 09:44:11 ET the same controller and Robocopy child were still running. Robocopy had read/written 88,900,577,751 bytes (~82.8 GiB), and C: retained 575,765,700,608 free bytes. Six-root copy, per-file checksums, metadata exclusions, SQLite backup/integrity checks, restore sample, and ACL metadata remain pending. No archive data is copied to this Mac.

The initial SSH-child launch exited when its SSH session ended; its unverified directory was preserved under `hermes-final-20261016.incomplete-0847`. Review also found auth/config backup filename variants, so exclusions were broadened and checked before the WMI launch. No secret values were read or displayed. The incomplete directory is retained, not a usable recovery archive.

The archive will remain a **baseline**, not a final quiescent seal, while held writers are active. Credentials/configuration are excluded by metadata; retain original PC/account custody and reauthenticate for recovery. Reparse targets are inventoried rather than blindly traversed.

## Continuation

At the next wake after 09:52:58 ET, read both item 4 cron entries using make-cron-probe.py read mode and capture item04-state.ps1 again. Verify both disabled, unchanged last_run_at/execution IDs, zero ALL unfinished executions, and report safe cursor/fingerprint deltas against item04-state-disabled.json. The manual watch can complete after its full 15-minute interval, but the SO watch needs the full hour through 10:37:57 ET. Do not begin item 5 until both item 4 observations pass. Persist another wake for that deadline and any pending archive verification.

Items 1–3 are verified complete; do not repeat disables/stops. All HOLD/Tier C enabled states were revalidated unchanged after item 4. The coordinator now reports replacement cutover rejected pending repairs, so those Windows jobs remain held. Item 5 helper found at `C:\Users\nicho\.hermes\scripts\check_martine_reply.py`; static inspection found no file-writing calls or local cursor path. Do not execute it.

Item 7 still requires proof of no unique pending downstream-consumed output. The broad six-root read-only source scan timed out after 240 seconds without a completed report. Its exact leftover Python probe was identified by PID, creation time and SHA-256 of its decoded source, then stopped; the archive and business processes were not targeted. Do not use the incomplete scan as consumer-absence proof. Use a bounded audit of active task/cron script dependencies later, or report/skip item 7 if the prerequisite cannot be established.

Keep the original full GO/HOLD list and never run business scripts or delete files. No application source changes, build or production restart are involved. Send complete items1–9 results to fce19860 using request_key `hermes-pc-operator-phase2`, with a separate archive verification report when actually verified.

## Artifacts

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/SHA256SUMS.txt)
- [archive-and-probe-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-and-probe-status.json)
- [archive-and-probe-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-and-probe-status.ps1)
- [archive-launch-command.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-command.ps1)
- [archive-launch-wmi.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-wmi.ps1)
- [archive-pause-exclusions.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.json)
- [archive-pause-exclusions.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.ps1)
- [archive-pc.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pc.py)
- [archive-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.json)
- [archive-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.ps1)
- [archive-start-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start-wmi.json)
- [archive-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start.json)
- [archive-status-0850.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-0850.json)
- [archive-status-0928.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-0928.json)
- [archive-status-item04-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-item04-start.json)
- [archive-status-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-wmi.json)
- [archive-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.json)
- [archive-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.ps1)
- [audit-drift.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/audit-drift.py)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/cron-control.py)
- [current-inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/current-inventory.json)
- [discover-runtime.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.json)
- [discover-runtime.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.ps1)
- [drift-after-item04.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-after-item04.json)
- [drift-check-after-item03.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-item03.json)
- [drift-check-after-tim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-tim.json)
- [inventory-after-item03-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item03-disable.json)
- [inventory-after-item04-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item04-disable.json)
- [inventory-after-tim-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-tim-stop.json)
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
- [item04-manual-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-before.json)
- [item04-manual-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-before.ps1)
- [item04-manual-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-disable.json)
- [item04-manual-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-manual-disable.ps1)
- [item04-so-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-before.json)
- [item04-so-before.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-before.ps1)
- [item04-so-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-disable.json)
- [item04-so-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-so-disable.ps1)
- [item04-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state-disabled.json)
- [item04-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item04-state.ps1)
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
