# Hermes Phase 2 — execution checkpoint

Authority: Nick’s October 16 SSH stop approval in chat fce19860, followed by the explicit GO list in this coordination thread. No Hermes job was invoked. No files were deleted. Held jobs, gateways, and Tier C items remain unchanged.

## Item status

| Item | State | Evidence / next step |
| --- | --- | --- |
| 1 Completion Mirror | Verified disabled | Disabled 08:39:15 ET. No in-flight process. Observed through 08:44:30 ET, covering a full five-minute cycle; last run stayed 08:35:15 ET, no relaunch. Shared ledger preserved; All Order Review remains its held writer. |
| 2 Brent and Brady | Disabled; observation pending | Brent disabled 08:44:46 ET; Brady 08:45:00 ET. Last execution records completed, no unfinished records among captured recent runs. Observe after 08:50:01 ET before disabling Tim watchdog, renaming its launcher, and stopping gateway. Both named cursor files were absent at 08:48:21 ET; no synthetic cursor created. |
| 3–9 | Not yet changed | Continue item by item after prior observation passes. |

## PC-only archive

The running recovery baseline is `C:\Users\nicho\backups\hermes-final-20261016`, launched through Windows WMI at 08:47:43 ET. A separate SSH check confirmed both controller PID 19500 and its Robocopy child PID 18796 survived the SSH session. Six-root copy, per-file checksums, metadata exclusions, SQLite backup/integrity checks, restore sample, and ACL metadata remain pending. No archive data is copied to this Mac.

The initial SSH-child launch exited when its SSH session ended; its unverified directory was preserved under `hermes-final-20261016.incomplete-0847`. Review also found auth/config backup filename variants, so exclusions were broadened and checked before the WMI launch. No secret values were read or displayed. The incomplete directory is retained, not a usable recovery archive.

The archive will remain a **baseline**, not a final quiescent seal, while held writers are active. Credentials/configuration are excluded by metadata; retain original PC/account custody and reauthenticate for recovery. Reparse targets are inventoried rather than blindly traversed.

## Continuation

At the next wake, first inspect fresh cron state and the execution ledger for both Tim jobs. Confirm no new execution IDs, unchanged last-run timestamps, disabled flags, and no pending claims after the full observation interval. Recheck cursor-file absence. Then perform the Tim gateway sequence in order, with fresh process identity and no-in-flight checks, and observe 15 minutes. Continue items 3–9; never run a job to test. Check archive process/status without retrying an uncertain launch. Send the complete result to fce19860 using request_key `hermes-pc-operator-phase2` after items 1–9, and a separate archive verification result when available.

## Artifacts

- [archive-launch-command.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-command.ps1)
- [archive-launch-wmi.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-launch-wmi.ps1)
- [archive-pause-exclusions.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.json)
- [archive-pause-exclusions.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pause-exclusions.ps1)
- [archive-pc.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-pc.py)
- [archive-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.json)
- [archive-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-preflight.ps1)
- [archive-start-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start-wmi.json)
- [archive-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-start.json)
- [archive-status-wmi.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status-wmi.json)
- [archive-status.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.json)
- [archive-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-status.ps1)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/cron-control.py)
- [current-inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/current-inventory.json)
- [discover-runtime.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.json)
- [discover-runtime.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/discover-runtime.ps1)
- [item01-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.json)
- [item01-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-disable.ps1)
- [item01-observe-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe-final.json)
- [item01-observe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.json)
- [item01-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item01-observe.ps1)
- [item02-brady-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.json)
- [item02-brady-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brady-disable.ps1)
- [item02-brent-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.json)
- [item02-brent-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-brent-disable.ps1)
- [item02-state-before-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state-before-observation.json)
- [item02-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/item02-state.ps1)
- [make-cron-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/make-cron-probe.py)
- [mirror-ledger-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.json)
- [mirror-ledger-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/mirror-ledger-discovery.ps1)
- [review-targets.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.json)
- [review-targets.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/review-targets.ps1)
- [run-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/run-probe.py)
- [source-lock-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.json)
- [source-lock-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/source-lock-review.ps1)
- [start-archive.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/start-archive.ps1)
- [state-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.json)
- [state-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/state-discovery.ps1)
- [tim-state-review.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.json)
- [tim-state-review.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/tim-state-review.ps1)

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/SHA256SUMS.txt)
