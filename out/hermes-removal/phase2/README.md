# Hermes Phase 2 — execution checkpoint

Authority: Nick’s October 16 SSH stop approval in chat fce19860, followed by the explicit GO list in this coordination thread. No Hermes job was invoked. No files were deleted. Held jobs, gateways, and Tier C items remain unchanged.

## Item status

| Item | State | Evidence / next step |
| --- | --- | --- |
| 1 Completion Mirror | Verified disabled | Disabled 08:39:15 ET. No in-flight process. Observed through 08:44:30 ET, covering a full five-minute cycle; last run stayed 08:35:15 ET, no relaunch. Shared ledger preserved; All Order Review remains its held writer. |
| 2 Brent and Brady / Tim gateway | Verified retired | Both watcher cron entries stayed disabled with unchanged last-run times/execution IDs and zero ALL unfinished executions through 09:28 ET. Both cursor files remain absent. Watchdog disabled 08:51:54 ET, active launcher renamed with original SHA-256 preserved, exact gateway stopped 08:51:55 ET. Final 09:27:58 ET observation passed all checks after 2,162 seconds: no relaunch, watchdog last run unchanged, active launcher absent, disabled launcher hash unchanged. |
| 3 Inventory sync incident router | Disabled; five-minute observation pending | Disabled 09:28:55 ET under scheduler lock. No unfinished execution. Next nominal trigger 09:32:54 ET; require a full five-minute check after 09:33:55 ET. Local state log SHA-256 f97f3fc2aa9b0e67b5bb9e6e18860d883bae02eed399215d00d6968f5a8daf0e; last modified Oct 15, recent statuses failed, no authoritative current open-incident count or claim cursor. Preserve original state; do not claim zero remote incidents. |
| 4–9 | Not yet changed | Continue serially after item 3 observation passes. |

## PC-only archive

The running recovery baseline is `C:\Users\nicho\backups\hermes-final-20261016`, launched through Windows WMI at 08:47:43 ET. A separate SSH check confirmed both controller PID 19500 and its Robocopy child PID 18796 survived the SSH session. At 09:29:20 ET the same controller and Robocopy child were still running. Robocopy had read/written 77,800,005,928 bytes (~72.5 GiB), and C: retained 588,908,630,016 free bytes. Six-root copy, per-file checksums, metadata exclusions, SQLite backup/integrity checks, restore sample, and ACL metadata remain pending. No archive data is copied to this Mac.

The initial SSH-child launch exited when its SSH session ended; its unverified directory was preserved under `hermes-final-20261016.incomplete-0847`. Review also found auth/config backup filename variants, so exclusions were broadened and checked before the WMI launch. No secret values were read or displayed. The incomplete directory is retained, not a usable recovery archive.

The archive will remain a **baseline**, not a final quiescent seal, while held writers are active. Credentials/configuration are excluded by metadata; retain original PC/account custody and reauthenticate for recovery. Reparse targets are inventoried rather than blindly traversed.

## Continuation

At the next wake after 09:33:55 ET, read item03 cron d68cb0c1ae05 with make-cron-probe.py read mode, write item03-observe.json, and compare its disabled flag, last_run_at, execution IDs, and ALL unfinished execution count against item03-disable.json. Re-run item03-state.ps1 and compare state file hashes/mtime to item03-state-disabled.json. Record the final local delta and limits; no source-system incident list has been queried. After that observation passes, begin item 4: ervp-orders 330388e25e93 and 305da2ff8a02, capture states, disable both under the scheduler lock, and observe the longer actual scheduled interval before item 5.

Items 1–2 are complete: never repeat Tim stops. A fresh 09:30 drift comparison confirmed only approved items1–3 enabled-state/Startup changes; all HOLD and Tier C states remain unchanged. The coordinator was sent an informational checkpoint for its 09:32 review. Keep the original full GO/HOLD list, do not run any business script, and persist every pending observation/archive wake. No source build or production restart is involved. Send complete items1–9 results to fce19860 using request_key `hermes-pc-operator-phase2`, and separately send verified archive results when actually available.

## Artifacts

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/SHA256SUMS.txt)
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
- [archive-status-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-wmi.json)
- [archive-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.json)
- [archive-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.ps1)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/cron-control.py)
- [current-inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/current-inventory.json)
- [discover-runtime.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.json)
- [discover-runtime.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.ps1)
- [drift-check-after-item03.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-item03.json)
- [drift-check-after-tim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-tim.json)
- [inventory-after-item03-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-item03-disable.json)
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
- [item03-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-disable.json)
- [item03-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-disable.ps1)
- [item03-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-disabled.json)
- [item03-state-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-review.json)
- [item03-state-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state-review.ps1)
- [item03-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item03-state.ps1)
- [make-cron-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/make-cron-probe.py)
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
- [source-lock-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.json)
- [source-lock-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.ps1)
- [start-archive.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/start-archive.ps1)
- [state-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.json)
- [state-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.ps1)
- [tim-state-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.json)
- [tim-state-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.ps1)
