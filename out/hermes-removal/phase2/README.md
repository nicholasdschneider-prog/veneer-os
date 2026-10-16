# Hermes Phase 2 — execution checkpoint

Authority: Nick’s October 16 SSH stop approval in chat fce19860, followed by the explicit GO list in this coordination thread. No Hermes job was invoked. No files were deleted. Held jobs, gateways, and Tier C items remain unchanged.

## Item status

| Item | State | Evidence / next step |
| --- | --- | --- |
| 1 Completion Mirror | Verified disabled | Disabled 08:39:15 ET. No in-flight process. Observed through 08:44:30 ET, covering a full five-minute cycle; last run stayed 08:35:15 ET, no relaunch. Shared ledger preserved; All Order Review remains its held writer. |
| 2 Brent and Brady / Tim gateway | Watchers verified; gateway observation pending | At 08:50:25–26 ET both jobs remained disabled, last-run times and recent execution IDs were unchanged, and ALL unfinished execution counts were zero. Both cursor files remain absent. Tim watchdog disabled 08:51:54 ET; active launcher renamed to .disabled-20261016 with unchanged SHA-256; exact gateway PID 10056 stopped 08:51:55 ET after verifying creation time/parent, no child processes, zero unfinished executions across the entire profile, and active_agents=0 in the matching runtime status (last status transition was Oct 15; fresh heartbeat confirmed the same running gateway). Immediate and interim checks found no relaunch. Complete the 15-minute check after 09:06:55 ET. |
| 3–9 | Not yet changed | Continue item by item after prior observation passes. |

## PC-only archive

The running recovery baseline is `C:\Users\nicho\backups\hermes-final-20261016`, launched through Windows WMI at 08:47:43 ET. A separate SSH check confirmed both controller PID 19500 and its Robocopy child PID 18796 survived the SSH session. At 08:50:28 ET the same controller and Robocopy child were still running. Six-root copy, per-file checksums, metadata exclusions, SQLite backup/integrity checks, restore sample, and ACL metadata remain pending. No archive data is copied to this Mac.

The initial SSH-child launch exited when its SSH session ended; its unverified directory was preserved under `hermes-final-20261016.incomplete-0847`. Review also found auth/config backup filename variants, so exclusions were broadened and checked before the WMI launch. No secret values were read or displayed. The incomplete directory is retained, not a usable recovery archive.

The archive will remain a **baseline**, not a final quiescent seal, while held writers are active. Credentials/configuration are excluded by metadata; retain original PC/account custody and reauthenticate for recovery. Reparse targets are inventoried rather than blindly traversed.

## Continuation

At the next wake, run item02-gateway-observe.ps1 after 09:06:55 ET and require every check to pass. Recheck both watcher cron records in read mode and both absent cursor files. Do not repeat the completed gateway stop. The 08:52 drift comparison confirms all other cron/task enabled states and Tier C Startup entries stayed unchanged. Only after the full Tim gateway observation passes, begin item 3 (ervp-manager d68cb0c1ae05). Continue items 3–9; never run a job to test. Check archive process/status without retrying an uncertain launch. Send the complete result to fce19860 using request_key `hermes-pc-operator-phase2` after items 1–9, and a separate archive verification result when available.

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
- [archive-status-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-wmi.json)
- [archive-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.json)
- [archive-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.ps1)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/cron-control.py)
- [current-inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/current-inventory.json)
- [discover-runtime.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.json)
- [discover-runtime.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.ps1)
- [drift-check-after-tim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/drift-check-after-tim.json)
- [inventory-after-tim-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/inventory-after-tim-stop.json)
- [item01-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.json)
- [item01-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.ps1)
- [item01-observe-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe-final.json)
- [item01-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.json)
- [item01-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.ps1)
- [item02-brady-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.json)
- [item02-brady-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.ps1)
- [item02-brady-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-observe.json)
- [item02-brady-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-observe.ps1)
- [item02-brent-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.json)
- [item02-brent-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.ps1)
- [item02-brent-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-observe.json)
- [item02-brent-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-observe.ps1)
- [item02-gateway-interim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-interim.json)
- [item02-gateway-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-observe.ps1)
- [item02-gateway-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-preflight.json)
- [item02-gateway-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-preflight.ps1)
- [item02-gateway-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-stop.json)
- [item02-gateway-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-gateway-stop.ps1)
- [item02-state-after-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-after-observation.json)
- [item02-state-before-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-before-observation.json)
- [item02-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state.ps1)
- [item02-watchers-confirmed.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-watchers-confirmed.json)
- [make-cron-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/make-cron-probe.py)
- [mirror-ledger-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.json)
- [mirror-ledger-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.ps1)
- [next-state-source-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/next-state-source-review.json)
- [next-state-source-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/next-state-source-review.ps1)
- [review-targets.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.json)
- [review-targets.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.ps1)
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
