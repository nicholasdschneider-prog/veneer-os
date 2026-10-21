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

Next wake after 14:00:18.885Z: run each existing step01-<ID>-read.ps1 into NEW step01-<ID>-final.json; compare to each disable receipt. Require full schedule elapsed, disabled flag, unchanged last_run/recent execution IDs/total count and zero unfinished selected/all-profile. Run step01-state.ps1 to step01-state-final.json and compare file hash/mtime; gateway heartbeat can change while gateway remains live. static-source-prep.ps1 records state field fingerprints and wrapper references without executing source; originals/customer bodies/secrets stay on PC. Preserve any delta and limits. Then step 2.

At 09:49:22 ET, a new scheduler-locked checkpoint confirmed all four disabled, unchanged last_run/recent IDs/total execution counts and zero selected/all-profile unfinished executions. The first three full intervals passed; Archer remained short of its 30-minute interval. See step01-checkpoint-0949.json.

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
- [phase2b-state.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/phase2b-state.json)
- [static-source-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/static-source-prep.json)
- [static-source-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/static-source-prep.ps1)
- [step01-2a806c33e3f2-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-before.json)
- [step01-2a806c33e3f2-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-checkpoint-0949.json)
- [step01-2a806c33e3f2-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-disable.json)
- [step01-2a806c33e3f2-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-disable.ps1)
- [step01-2a806c33e3f2-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-2a806c33e3f2-read.ps1)
- [step01-59b1ee116748-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-before.json)
- [step01-59b1ee116748-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-checkpoint-0949.json)
- [step01-59b1ee116748-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-disable.json)
- [step01-59b1ee116748-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-disable.ps1)
- [step01-59b1ee116748-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-59b1ee116748-read.ps1)
- [step01-c94a14183a61-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-before.json)
- [step01-c94a14183a61-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-checkpoint-0949.json)
- [step01-c94a14183a61-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-disable.json)
- [step01-c94a14183a61-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-disable.ps1)
- [step01-c94a14183a61-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-c94a14183a61-read.ps1)
- [step01-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-checkpoint-0949.json)
- [step01-ece0db616afe-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-before.json)
- [step01-ece0db616afe-checkpoint-0949.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-checkpoint-0949.json)
- [step01-ece0db616afe-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-disable.json)
- [step01-ece0db616afe-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-disable.ps1)
- [step01-ece0db616afe-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-ece0db616afe-read.ps1)
- [step01-state-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state-before.json)
- [step01-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state-disabled.json)
- [step01-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step01-state.ps1)
