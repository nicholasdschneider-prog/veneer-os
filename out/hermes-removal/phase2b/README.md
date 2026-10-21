# Hermes Phase 2b — October 21 retirement

Nick’s own October 21 decision in coordinator chat fce19860 releases the prior HOLD list: retire all remaining Hermes work. No Veneer lane is to go live, and PC retirement no longer waits for a cutover. Nick’s October 21 “Delete it too” instruction, relayed in this thread, approves Phase 3 source-root deletion in advance. No further confirmation is required after the hard quiescent-seal gate passes. No deletion is authorized before that gate.

## Current checkpoint

Step 1 four manager crons disabled once under .jobs.lock at 13:30:16–18Z; every disable had zero selected-job AND all-profile unfinished executions. Readback enabled=false. State/scripts metadata captured before and immediately after disables; original files remain on PC. No business script or Hermes job was invoked. No file was deleted. Prior Phase 2 stops were not repeated.

| Job | Disabled UTC | Full interval ends UTC |
| --- | --- | --- |
| ece0db616afe | 2026-10-21T13:30:16.517761+00:00 | 2026-10-21T13:45:16.517761+00:00 |
| 2a806c33e3f2 | 2026-10-21T13:30:17.292073+00:00 | 2026-10-21T13:35:17.292073+00:00 |
| 59b1ee116748 | 2026-10-21T13:30:18.089462+00:00 | 2026-10-21T13:35:18.089462+00:00 |
| c94a14183a61 | 2026-10-21T13:30:18.884212+00:00 | 2026-10-21T14:00:18.884212+00:00 |

Step 1 VERIFIED at 10:07 ET after at least 2209 seconds for every cron: all disabled, same last_run/recent execution IDs/total executions, zero selected and all-profile unfinished work. Final state comparison shows only the live gateway heartbeat changed; other captured state and script hashes/mtime stayed unchanged. Capture is bounded local metadata, not an assertion about remote mailbox contents. See step01-observation.json.

Step 2 all four crons disabled once at 14:08:55–58Z under .jobs.lock, each with zero selected and ALL-profile unfinished work. Before-state and disabled-state receipts capture the actual vendor watchdog cursor/commands, LTL source/lock metadata where present, and Lippert report plus owner.sqlite3 (117 runs, no operations or active lease). Raw bodies remain on PC. Exact missing vendor-order-runs paths are listed, with no claim of a remote pending-row count. Selected sources and field fingerprints are preserved. Between expanded before-capture and disabled-capture, the vendor cursor content SHA and every field fingerprint stayed unchanged, with mtime only changed; two SQLite -shm mtimes also changed with identical SHA. The live orders gateway heartbeat changed. See step02-state-disable-delta.json; no cause is attributed to the mtime changes.

| Job | Disabled UTC | Full interval ends UTC |
| --- | --- | --- |
| ce09b813238c | 2026-10-21T14:08:55.702246+00:00 | 2026-10-21T14:09:55.702246+00:00 |
| b95f03d799dc | 2026-10-21T14:08:56.489140+00:00 | 2026-10-22T02:08:56.489140+00:00 |
| 9b03a939ef99 | 2026-10-21T14:08:57.316482+00:00 | 2026-10-22T02:08:57.316482+00:00 |
| 9868ee5f2643 | 2026-10-21T14:08:58.163113+00:00 | 2026-10-21T14:23:58.163113+00:00 |

At 10:24:38 ET, vendor alerts and Lippert PASSED their full 1/15-minute intervals (940 seconds elapsed). All four readbacks remain disabled, unchanged last_run/recent IDs/counts, selected and ALL-profile unfinished0. Both LTL checks are interim only: full720-minute deadlines remain 2026-10-22 02:08:56–57Z (Oct21 22:08:56–57 ET). No Step3 mutation until both pass. Current state comparison: gateway heartbeat SHA/mtime changed; owner.sqlite3-shm and safe-vendor-poller.sqlite3-shm changed mtime only, identical SHA; all other captured file metadata/field hashes unchanged. See step02-observation-1024.json.

Step3 bounded read-only preparation found actual stores and source lock protocols, but is NOT final drained custody. See [step03-preparation.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-preparation.md). Direct was Running at10:26:49ET; no task was disabled or stopped. The lane directory lock does not prove full-cycle scheduler ownership, which still needs reconciliation before final custody and Direct disable. Never reuse that historical process identity or remove an existing lock. Next wake after02:09Z for final LTL readbacks/state comparison and then Step3 only if all pass.

## Remaining sequence

2. Disable orders vendor failure ce09b813238c, orders LTL b95f03d799dc, root LTL 9b03a939ef99, dev2 Lippert 9868ee5f2643 (unconditional now). Capture actual state first. Both LTL schedules are 720 minutes: observe their full interval before declaring them verified; never force a run.
3. Disable All_Order_Review and Direct_Shopify tasks only with no in-flight work. Before Direct disable, wait for existing owner-policy cycle and acquire its actual scheduler lock, then capture owner-policy-candidates.json, owner-policy lane, governance outbox, pending Lippert/Dometic rows into a sanitized final delta for Sage. Source prep is partial: actual lock and store locations still need bounded read-only discovery. Never invoke any helper/business module.
4. Disable hermesops vault drift and Brain Backup, preserving state and observing their actual cycles (vault30min, Brain task4h).
5. Stop remaining gateways serially after watchdog disable and active launcher rename, exact fresh process identity/no in-flight checks, full15min no-relaunch each. Fresh baseline has default/root11592, hermesops7544, accounting-migration15872, orders20624; manager was not live in that inventory but its watchdog remains enabled. Re-discover, never reuse these PIDs blindly. Zero final Hermes processes/enabled cron/enabled tasks/activeStartup. Tier C untouched.
6. Refresh six-root PC-only archive incrementally with no purge/delete, new manifest addendum, every SQLite integrity and restore test; record quiescent seal only after all writers stopped. Prior verified baseline remains preserved.
Phase 3 is approved in advance, exclusively after all quiescent-seal checks pass and a sealed verdict is recorded under phase3/. Then remove tasks/launchers/wrappers and the authorized Hermes roots in the specified order, with original hashes and sizes before/after. Preserve backups/, ervp-vendor-automation, orderops-src, Tailscale, OpenSSH and all non-Hermes assets. See [Phase 3 authority and gated execution plan](/Users/archerclawdington/veneer-os/out/hermes-removal/phase3/README.md). If the seal fails, stop and report without deleting.

## Fresh inventory findings / scope checks

Nine enabled Hermes cron entries match the new list. The two business tasks now trigger every5min(All_Order_Review) and15min(Direct_Shopify); use actual inventory rather than stale prior cadence. An enabled historical one-shot HermesDesktopUpdate-20260805 task also exists. Its exact role/Tier C status needs reconciliation before step5: do not silently mutate Tier C or assert zero enabled tasks while ignoring it. No new lane activation is authorized.

Coordinator reports are required under request_key hermes-pc-operator-phase2b after step5, after sealed step6, and with Phase3 source deletion plan. No source builds/restarts are needed. Persist each pending observation/seal wake.

## Artifacts

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/SHA256SUMS.txt)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/cron-control.py)
- [inventory-baseline.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-baseline.json)
- [make-probe.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/make-probe.py)
- [phase2b-state.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/phase2b-state.json)
- [static-source-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/static-source-prep.json)
- [static-source-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/static-source-prep.ps1)
- [step01-2a806c33e3f2-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-before.json)
- [step01-2a806c33e3f2-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-checkpoint-0949.json)
- [step01-2a806c33e3f2-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-disable.json)
- [step01-2a806c33e3f2-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-disable.ps1)
- [step01-2a806c33e3f2-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-final.json)
- [step01-2a806c33e3f2-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-read.ps1)
- [step01-59b1ee116748-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-before.json)
- [step01-59b1ee116748-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-checkpoint-0949.json)
- [step01-59b1ee116748-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-disable.json)
- [step01-59b1ee116748-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-disable.ps1)
- [step01-59b1ee116748-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-final.json)
- [step01-59b1ee116748-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-read.ps1)
- [step01-c94a14183a61-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-before.json)
- [step01-c94a14183a61-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-checkpoint-0949.json)
- [step01-c94a14183a61-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-disable.json)
- [step01-c94a14183a61-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-disable.ps1)
- [step01-c94a14183a61-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-final.json)
- [step01-c94a14183a61-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-read.ps1)
- [step01-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-checkpoint-0949.json)
- [step01-ece0db616afe-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-before.json)
- [step01-ece0db616afe-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-checkpoint-0949.json)
- [step01-ece0db616afe-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-disable.json)
- [step01-ece0db616afe-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-disable.ps1)
- [step01-ece0db616afe-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-final.json)
- [step01-ece0db616afe-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-read.ps1)
- [step01-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-observation.json)
- [step01-state-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state-before.json)
- [step01-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state-disabled.json)
- [step01-state-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state-final.json)
- [step01-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state.ps1)
- [step02-9868ee5f2643-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-before.json)
- [step02-9868ee5f2643-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-disable.json)
- [step02-9868ee5f2643-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-disable.ps1)
- [step02-9868ee5f2643-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-observe-1024.json)
- [step02-9868ee5f2643-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-read.ps1)
- [step02-9b03a939ef99-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-before.json)
- [step02-9b03a939ef99-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-disable.json)
- [step02-9b03a939ef99-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-disable.ps1)
- [step02-9b03a939ef99-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-observe-1024.json)
- [step02-9b03a939ef99-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-read.ps1)
- [step02-b95f03d799dc-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-before.json)
- [step02-b95f03d799dc-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-disable.json)
- [step02-b95f03d799dc-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-disable.ps1)
- [step02-b95f03d799dc-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-observe-1024.json)
- [step02-b95f03d799dc-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-read.ps1)
- [step02-ce09b813238c-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-before.json)
- [step02-ce09b813238c-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-disable.json)
- [step02-ce09b813238c-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-disable.ps1)
- [step02-ce09b813238c-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-observe-1024.json)
- [step02-ce09b813238c-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-read.ps1)
- [step02-observation-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-observation-1024.json)
- [step02-path-discovery-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-path-discovery-expanded.json)
- [step02-path-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-path-discovery.json)
- [step02-path-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-path-discovery.ps1)
- [step02-path-discovery.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-path-discovery.py)
- [step02-state-before-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state-before-expanded.json)
- [step02-state-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state-before.json)
- [step02-state-disable-delta.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state-disable-delta.json)
- [step02-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state-disabled.json)
- [step02-state-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state-observe-1024.json)
- [step02-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state.ps1)
- [step02-state.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-state.py)
- [step03-lock-schema-prep-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep-expanded.json)
- [step03-lock-schema-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.json)
- [step03-lock-schema-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.ps1)
- [step03-lock-schema-prep.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.py)
- [step03-preparation.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-preparation.md)
- [step03-source-prep-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep-expanded.json)
- [step03-source-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.json)
- [step03-source-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.ps1)
- [step03-source-prep.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.py)
- [step03-task-settings.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-task-settings.json)
- [step03-task-settings.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-task-settings.ps1)
