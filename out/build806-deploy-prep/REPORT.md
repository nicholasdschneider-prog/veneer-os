# BUILD806 combined deployment preparation (2026-10-13)

Owner: Platform Dev a6e39d6e (original BUILD806 owner). Prepared 21:26–21:45Z (17:26–17:45 ET).
No restart, recovery, credential change, source edit or queue change was made. No deploy approval is requested.

## 1. Cumulative source pin

| | |
|---|---|
| main / origin/main | `7a74def72d13e5c79a99f24892a65e566a48ce7f` |
| Last source commit | `db8b7f0` (#806). `7a74def` changes only `out/build767/live-check-result-2026-10-13.md`; `git diff db8b7f0 HEAD -- server web browser-manager installer scripts package*.json` is empty |
| Commits not yet live on runner+web | `f9c59dd` (#790), `ebf83cf`, `ef04461`, `10cb103`, `1653378` (#801), `274e669` (#804), `db8b7f0` (#806) |
| Pending migrations | `0178_purchase_interrupted_recovery.sql` sha256 `a6205c95c21865e2d2b11314d18fe4f4954c417c0e796ed6ded5c99f0ff60877` (added in 1653378); `0179_qbo_phase_transport.sql` sha256 `ec134af0060f5172723d00c8de2f71263be537e683b3a891ed137e3905ef0e5f` (added in 274e669). Source and `server/dist/db/migrations` copies are identical. Live DB has applied through 0177 |
| Migration shape | 0178/0179 only `CREATE TABLE` + immutability triggers. Additive; the old `migrate.ts` warns but does not refuse on extra applied migrations, so a code rollback stays schema-compatible |

## 2. Artifact pin

| Artifact | Files | Manifest sha256 (sha256 of the sorted per-file manifest) |
|---|---|---|
| `server/dist` (built 17:03:56 ET) | 577 | `87dce0c6284c02b5cd7a82d7e96659140540ddf90202914263f31608cc2a4d12` → [manifest-server-dist.sha256](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-server-dist.sha256) |
| `web/dist` (built 17:04:11 ET) | 2529 | `02d52cae934a7d5293545b63a310232f93d6d12263bb44a8a6d0abaee9565983` → [manifest-web-dist.sha256](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-web-dist.sha256) |

Provenance check: a clean rebuild of `7a74def` in a temporary worktree ([build-repro.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-repro.log)) produced `server/dist` **byte-identical** to the live one (577/577 files). All 505 rebuilt `web/dist` files are present and identical in the live `web/dist`. The other 2024 live files are older hashed assets that the prune policy keeps on purpose.

Forward bundle of the live dist: `~/.local/share/veneer-pro-predeploy/build806-20261013/forward-7a74def-live-dist.tgz`, sha256 `a85fc0ffe8c4b05aabf089161d229dd54279fa686c25b8b7867bdec8d7683cae` (0600, directory 0700).

## 3. Final combined validation (this change set, at 7a74def)

Run under the host development lock with the configured single worker, and nothing else ran alongside it. Status: [validate-status.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/validate-status.log).

- `npm run typecheck`: exit 0 ([typecheck.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/typecheck.log))
- `npm test`: exit 0 ([full-test.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/full-test.log))
  - installer 32/32
  - server 299 files, 4045 passed, 16 skipped
  - web 146 files, 1015 passed
  - browser-manager 52/52
- `npm run build` (isolated worktree only): exit 0. The live dist was not rebuilt, so the armed waiter's dist-mtime guard is untouched.
- Read-only `restart.mjs --health-check`: local web and runner healthy, tunnel 4 edges, public front door 302. `--check`: native modules load. See [precheck-health.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/precheck-health.log) and [precheck-runtime.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/precheck-runtime.log).

## 4. Rollback

**The prior healthy executable artifact is not available.** The running services loaded code from a `dist` that has since been rebuilt in place, and no copy was kept:
- runner pid 34641, started 12:05 ET. Its code predates 0176 (12:52 ET); likely the 4cf591e era. Exact build not provable.
- web pid 89325, started 14:57 ET. Its build was made after 0177 was applied (13:56 ET) and at or before 14:57 ET, so somewhere between 9009c80 and f9c59dd. Exact commit not provable.
- app-runner 60007 and term 60023 started 09:04 ET; they are not in the restart scope.

What is prepared instead is a **reconstructed rollback candidate**, not proof of the running bytes:
- `1b8561a` = `f9c59dd^`, the last commit before the held deployment set. It was built cleanly in an isolated worktree with the same dependencies; package files have no diff from HEAD ([build-rollback.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-rollback.log)).
- Bundle: `~/.local/share/veneer-pro-predeploy/build806-20261013/rollback-1b8561a-dist.tgz`, sha256 `df45cfd586d60d17cfa7eb5754c7f182258b05137005dea2d63597251962ca18`. Manifests: [server](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-rollback-server-dist.sha256), [web](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-rollback-web-dist.sha256).
- It passed build and typecheck. Its full test suite was not re-run here.
- Applying it (only under the same approved window and owner, if post-restart readback fails):
  1. Extract to a new temp directory and verify the manifests.
  2. Replace `server/dist` wholesale. Copy `web/dist` files in without deleting the retained assets.
  3. Restart `veneer-pro-runner` and `veneer-pro` once.
  - No source reset, no DB restore. 0178/0179 tables stay; old code ignores them.

## 5. Database backup

- Online backup (SQLite backup API, read-only source, new file, live DB and nightly backup directory untouched): `~/.local/share/veneer-pro-predeploy/build806-20261013/veneer-pro-online-20261013T213953Z.db`.
  - Taken at 21:39:53Z, size 1,089,155,072 bytes, file 0600, directory 0700.
  - sha256 `168bddce709f7075b220e323916b433dbd5866475ed06379275eeef0f6ed11b7`.
- Checks on the copy (opened `immutable=1`; hash re-verified unchanged afterwards):
  - `integrity_check` = `ok`
  - `foreign_key_check` = 0 rows
  - migrations through 0177, hashes match the live DB
- Kept outside `veneer-pro-backups`, so nightly rotation never counts or prunes it.
- Re-take it within 15 minutes before the restart. It takes about 5 seconds; same command, new timestamped file.

## 6. UNKNOWN and readback plan for the restart

Before:
- Re-take the backup.
- Confirm `git diff db8b7f0 HEAD -- server web browser-manager installer scripts package*.json` is empty and both dist manifests match this report. HEAD itself advances with report-only commits, including this report's (0e554c2). Any difference means stop and re-validate.
- Confirm zero pending turns. `restart.mjs` refuses otherwise; there were 6 pending at 21:30Z.

Run once: `npm run restart -- --maintenance-approved veneer-pro-runner veneer-pro`.

If the result is uncertain (timeout, lost output, exit ≠ 0), do **not** re-run. First read:
1. `DATA_DIR/run/veneer-pro.pid` and `veneer-pro-runner.pid`, plus `ps -o lstart` for those pids. New pids with a start after the window opened mean the restart happened.
2. `restart.mjs --health-check`.
3. `select name, content_hash from migrations where name >= '0178'`. Expect the two hashes in section 1.
4. `pragma foreign_key_check` (read-only).
5. The last 200 lines of runner and web logs for `[migrate]` / DRIFT / boot errors.

Then decide: done, a single restart of the one service that did not come back, or rollback per section 4.

After:
- #806 readback: Archer's `record_custom_direction_review` with `nonfinancial_direction` scope for decision 0f24e56b succeeds (owned by a6e39d6e).
- #801 purchasing recovery readback stays with the original BUILD801 owner. UNKNOWN purchases are excluded and never replayed by this deployment.
- Report the SHA and new pids in thread 9d6d01d1.

## 7. Blockers and window readiness

- **Armed overnight waiter will refuse.** `/tmp/veneer-790/overnight2.sh` (pid 19919, owner 852806d0, 02:00–05:00 ET 10/14) checks `ARM_HEAD=db8b7f0` against `git rev-parse --short=7 HEAD`. HEAD became `7a74def` at 17:11:45 ET, 88 s after it was armed (17:10:17). It will log "NOT restarting" even though the source is identical. Only its owner can re-arm it or adjust the guard. Not touched here.
- **Active turns:** 6 pending turns at 21:30Z. Any window needs a drain.
- **Not mine:** Sage's source review and the human/James approval for a specific window are outside this preparation.

Readiness: from the BUILD806 side, artifacts, validation, provenance, backup and plans are **ready for 6:00–6:15 PM ET today**. That window is executable only if, in time:
- the approval names it,
- Sage's review is complete,
- turns drain (`restart.mjs` will refuse otherwise, and must not be forced).

Otherwise the bounded fallback is the existing 02:00–05:00 ET 10/14 window, which needs its owner to re-arm the waiter against the current HEAD or, better, a source-diff guard against db8b7f0, since report-only commits (including this report's) keep moving HEAD.

## 8. Addendum 21:50Z: exact postchecks, record pins, disposable rollback runtime check

Read-only postcheck script: [postcheck.sh](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/postcheck.sh).
- It pins migrations ≥0176 (name/content_hash), the 0178/0179 schema objects, row counts of the five new tables, the original BUILD801 records and the FK check.
- Raw row contents stay in the 0700 predeploy directory. Only hash lines are committed here.

**Before-pin, live DB at 21:43:42Z** ([hashes](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/pin-before-20261013T214342Z.hashes.txt)). Each record was found:
- run `7056b7cc…` (scheduled_task_runs)
- task `9c72a42a…` (scheduled_tasks)
- batch `551a9f86…` (purchase_event_batches)
- worker start turn `b5914b51…` (purchase_worker_starts)
- exclusions `2080773d…` and `ae219af0…` (purchase_event_receipts and autoship_candidate_events)

The new tables do not exist yet, and there are 0 FK violations. These record hashes equal those taken on the 21:39:53Z backup.

**Disposable DB check** ([log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check.log), [script](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check.sh)). It ran on a temp copy of the backup, hash-verified before use and deleted afterwards; the live DB was not touched.
- **A.** The live artifact's `openDb` applied 0178 `a6205c95…0877` and 0179 `ec134af0…ef5f`.
  - Created `purchase_interrupted_reviews` and `purchase_interrupted_dispositions` with their 4 no_update/no_delete triggers.
  - Created `qbo_v2_invocations`, `qbo_v2_phases` and `qbo_bill_observations` with their 6 no_update/no_delete triggers.
  - All five tables have 0 rows; FK violations 0.
  - Every original record hash is unchanged from the baseline.
- **B.** The rollback candidate's (1b8561a) `openDb`, run twice on that migrated copy: exit 0, no DRIFT output, no pending application. State is identical to A.
- **C.** Re-forward with the live artifact: identical again.

Limit of this proof: it exercises the reconstructed 1b8561a candidate's DB open and migrate path only. It is not the exact executables now running, which were never retained. It also does not boot the old web or runner against the copy: booting them on a copy of production data could fire schedulers and sends. Do not claim more rollback proof than this.

**Postcheck after the restart:**
1. Run `postcheck.sh > $B/pin-after-<ts>.txt`, then diff its hash lines against the before-pin.
2. Expected:
   - Migrations show 0178/0179 with the hashes above.
   - The new-schema-objects section lists the 5 tables and 10 triggers, plus autoindexes.
   - All five counts are 0.
   - FK violations 0.
   - run/batch/worker-start/exclusion hashes are unchanged.
   - The task row may differ only in scheduler bookkeeping fields. Inspect the raw diff before calling it a change.
3. A non-zero count in purchase_interrupted_reviews/dispositions means something invoked recovery. Stop and route it to the BUILD801 owner; do not invoke recovery from here.
4. Rollback never drops the newer immutable ledgers and never restores the backup over the live DB.
