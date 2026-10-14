# BUILD806 combined deployment preparation (2026-10-13)

Owner: Platform Dev a6e39d6e (original BUILD806 owner). Prepared 21:26–21:45Z (17:26–17:45 ET).
No restart, recovery, credential change, source edit or queue change was made. No deploy approval is requested.

> **Status 2026-10-13 22:48Z: re-pinned to cumulative source `155b497` (#812). Not ready; no restart is approved or armed.** See section 13.
>
> - Source `155b49718ccfe5179fc25650d124cdaa1b91acc4` = `db8b7f0` + #812. Live `server/dist` is byte-identical to a clean rebuild; `web/dist` is unchanged from the 7a74def pin.
> - Source validation evidence is the #812 cumulative full-suite receipt at `155b497`; the full suite was not re-run.
> - The disposable forward/rollback/re-forward check passed again with the new live artifact.
> - Still open: the prior-runtime gate (1b8561a is a reconstruction; empty-ledger bound only), the registered-caller v2 read probe, end-to-end probes, timeout persistence, frozen runtime/parent custody and authoritative adapters.
> - The 21:39:53Z backup is stale. Retake it within 15 minutes before any approved restart. Order stays web then runner.
> - Sections 1–12 are the historical `db8b7f0` / `7a74def` record and are kept as evidence for #801/#804/#806.
>
> Earlier banner (22:41Z, superseded by section 13): the packet was historical while #812 edited the shared tree; no restart executor was armed (overnight3/overnight4 absent; #790 owner stopped overnight4 at 22:00:05Z), so the runner-first finding in section 12 is obsolete.

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
  3. Restart `veneer-pro` then `veneer-pro-runner` once (same order as section 12).
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

Run once: `npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner` (web first, then runner; see section 12).

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

## 7. Status and readiness (corrected 2026-10-13, read-only; supersedes the earlier 6:00–6:15 PM readiness text)

**This packet is not deployment-ready, and no window is claimed.** The earlier statement that it was "ready for 6:00–6:15 PM ET today" is withdrawn. Do not relay it as meeting any gate. This section asks for no approval and proposes no window.

What is closed:
- Final combined validation at source-equivalent `7a74def` (section 3): typecheck plus full `npm test`.
- The isolated reproducibility build (section 2).
- Queue clearance and no-mutation evidence (section 9).

Scope is the full cumulative set `f9c59dd`, `ebf83cf`, `ef04461`, `10cb103`, `1653378`, `274e669`, `db8b7f0` (table in section 12). HEAD advances only with report-only commits (e28ab7e, then 6555d91 and this correction). The shipped source still equals `db8b7f0`.

Open items, any of which blocks a "ready" claim:
1. **Verified prior artifact gate is not met.** The exact prior healthy bytes do not exist. The reconstructed `1b8561a` DB open/forward/rollback/re-forward check does not prove web or runner runtime rollback (sections 4 and 12).
2. **Restart order is unreconciled.** The packet and the BUILD801 plan say web first (`veneer-pro veneer-pro-runner`). The only armed executor, overnight3.sh (pid 42176, owner 852806d0), still runs runner first. One deployment owner has to reconcile the full cumulative plan. This packet does not edit scripts, source or the waiter.
3. **Probes not yet resolved:**
   - an authenticated native QBO pure-read caller (section 11);
   - an authenticated end-to-end chat probe (`restart.mjs --health-check` proves neither).
4. **Backup.** The 21:39:53Z backup is verified (section 5), but it must be retaken within 15 minutes before any restart that is actually approved.
5. **Separate from installation:**
   - Sage's original source review.
   - BUILD801 purchasing recovery. The UNKNOWN exclusions are not released.
   - No recovery or review writes are used as installation smoke. Post-install checks are the read-only `postcheck.sh` only.
6. **Active turns:** any restart has to wait for them to drain and must never be forced.

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

## 9. Queue clearance and no-mutation proof for the 21:28–21:39Z validation

Validation (typecheck + full `npm test`) ran 21:28:21–21:38:17Z. Isolated builds ran 21:38:47–21:39:26Z, in /tmp worktrees only.

Queue state (`build_queue`, read 21:46Z):
- **Veneer project (dc6e8855, root /Users/archerclawdington/veneer-os):** the last builds are #801 (6a752161, done 20:20:19Z), #804 (732adce5, done 20:44:46Z) and #806 (a6e39d6e, done 21:04:42Z). Nothing in this project was running or queued during the validation, and nothing is now.
- **Other projects, separate trees:**
  - ERVP (e8e0efc6, /Users/archerclawdington/Projects/ERVP): #802 done 21:26:35Z; #803 running since 21:30:37Z; #805, #808, #809 queued.
  - MP Health (9c808d67): #807 done 21:24:01Z.
- The host development lock was free before the run and free afterwards.

No-mutation evidence for /Users/archerclawdington/veneer-os:
- The reflog has no entries between 7a74def (21:11:45Z) and this packet's first commit, 0e554c2 (21:41:21Z), after validation ended.
- The tracked tree is clean (`git status --untracked-files=no` is empty).
- `git diff db8b7f0 HEAD` over server, web, browser-manager, installer, scripts and the package files is empty.
- Live `server/dist/index.js` (17:03:56 ET) and `web/dist/index.html` (17:04:11 ET) are unchanged, and no file under those source paths is newer than the dist.

Gap, stated plainly: I did **not** message other build owners before starting. Clearance rests on the queue record above (no active Veneer-scope build) plus the host lock, not on explicit owner acknowledgement. The only concurrent build, ERVP #803, works in a different tree. No other owner edited the shared veneer-os tree during the run, so no stop/re-pin was needed. If an owner reports otherwise, the run must be treated as invalid and repeated after re-pinning.

## 10. BUILD804 reconciliation, 21:48Z (read-only)

Input: the BUILD804 packet (`docs/reports/qbo-boundary/build804/validation.json`, validated at 274e669). Nothing was built, tested, restarted or invoked for this section.

- **Final combined suite.** Section 3 is the full-suite receipt for db8b7f0's source: HEAD 7a74def, empty source diff from db8b7f0. #804's 274e669 receipt is superseded by it, not needed on top of it.
- **Artifact pins match #804's.** Live `server/dist` and the pinned forward manifest have the same hashes:
  - `qbo/phaseBoundary.js` `7f0b9a49…ecad`
  - `qbo/phaseContract.js` `1837a7ca…c131`
  - `qbo/helperProcess.js` `5c83ba42…ef43`
  - `db/migrations/0179_qbo_phase_transport.sql` `ec134af0…ef5f`
- **Production wiring.** `bots/routes.ts:58` calls `qboRoutes(ctx)` with no resolver or transport, so it defaults to `unavailableFacts`/`unavailablePhaseResolver` (503 `QBO_ASSIGNMENT_AND_ACCOUNTING_BINDING_UNAVAILABLE`). The rollback candidate 1b8561a has the same v1 wiring (`qboRoutes(ctx)`, default `unavailableFacts`) and no v2 routes. QBO stays unavailable on both sides of a rollback.
- **Legacy QBO ledger baseline.** Live DB, read-only: `qbo_operation_reservations` 0 rows, `qbo_operation_receipts` 0 rows. No payloads were read.
- **Drift check.** `migrate.ts` `checkDrift` logs DRIFT but does not throw. Section 6 step 3 and section 8 already compare the recorded hashes explicitly; a successful boot is never taken as proof.

**Rollback assumption, explicitly bounded to empty ledgers.** The section 8 disposable check proves 1b8561a opens and migrates cleanly over 0178+0179 **with all five new ledgers empty and both legacy QBO ledgers empty**. It does not prove compatibility with populated v2 or recovery ledgers. Rule for the window:
- Code rollback to 1b8561a is permitted only if the post-restart counts for all five new tables and both legacy QBO tables are still 0.
- If any of them is non-zero: no code rollback without the owning build (#804 for QBO, #801 for purchasing).
- Never a down migration, row deletion or DB restore.

**#804's exact 0179 postchecks to run after the restart (read-only, in addition to `postcheck.sh`):**
- `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (3 tables + 6 triggers) ORDER BY type,name`: compare to the pinned 0179 SQL.
- `PRAGMA foreign_key_check` per QBO table.
- Counts for invocations, phases and observations, plus the legacy reservations and receipts counts.

## 11. Native v2 read probe after the restart (requirement from #804, recorded 2026-10-13)

The code was checked, and `phaseBoundary.read` (`server/src/qbo/phaseBoundary.ts:52`) is a pure lookup:
- It runs `authenticatedQboCaller`, then SELECTs on `qbo_operation_reservations`, `qbo_v2_phases` and `qbo_bill_observations`.
- It does not call the resolver or the helper transport, and it makes no provider request.

**The probe** (once, after the restart and after section 8's postcheck):
1. Read the counts for `qbo_v2_invocations`, `qbo_v2_phases` and `qbo_bill_observations` (expected 0/0/0).
2. Have an existing, active, registered-bot session POST `/api/qbo/v2/read` with `{"requestKey":"<fresh UUID>"}`, using its own `X-VP-Agent-Token`. Do not print the token.
3. Require `status:"ABSENT"`, `phaseProof:"ABSENT"`, `phases:[]` and `observation:null`, with all `execute`/`refreshEntitlement`/`operationEntitlement`/`retryAllowed` fields false.
4. Read the three counts again; they must be unchanged.

**Caller constraint.** Neither the BUILD806 owner chat (a6e39d6e) nor the BUILD804 chat (732adce5) has an active `bot_registrations` row, so neither can make this call. The call needs `QBO_NATIVE_AGENT_SESSION_REQUIRED` and a registered caller. The probe may be run only by one of the 16 active registered bots, in its own session. Do not mint a token, registration or grant for it, and do not borrow a token. If no such bot runs it in the window, record **runtime lookup: unverified**; do not enable anything to make it pass.

**Not postchecks:** `/qbo/v2/invoke`, `/qbo/v2/reconcile`, refresh, and any live QBO provider request.

**QBO operational acceptance stays pending:**
- Production `qboRoutes(ctx)` uses `unavailablePhaseResolver` and has no helper transport.
- Authoritative adapters, a runnable accepted closure, and sanctioned-parent/source acceptance are still missing.

## 12. Review reconciliation, 22:05Z (read-only; incorporates the BUILD801 coordination review)

An independent review re-verified all 577 `server/dist` and 2529 `web/dist` manifest entries and the empty `db8b7f0..HEAD` source diff. Its three findings are adopted here.

**Final command and order.** `scripts/restart.mjs` restarts `targets` in the order given (`for (const service of targets)`, line 449). Each `restart()` waits for `/health` before the next one starts, but a failed service does not stop the loop. Sections 4 and 6 previously listed runner then web, and the BUILD801 report (`docs/reports/purchase-interrupted/build801/report.md:53`) lists web then runner. The final order is the BUILD801 one:

`npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner`

- Web (`server/src/index.ts:81`) and runner (`server/src/runner/index.ts:62`) both call `openDb`, which migrates before anything else starts, so either order applies 0178/0179 before new code uses them.
- Web first means the migrations are applied by a process with no schedulers, and the new runner (purchasing recovery, QBO and custom-direction consumers) starts last against a schema that is already in place and verified healthy. The old runner tolerates the extra tables for the short gap because the change is additive.
- If web fails `/health`, the loop still restarts the runner. Treat that as an uncertain result under section 6: read, do not re-run.
- Rollback (section 4, step 3) uses the same order.

**One deployment owner.** Exactly one executor may run this command. At 21:56Z the only armed executor is `/tmp/veneer-790/overnight3.sh` (pid 42176, owner 852806d0, 02:00–05:00 ET 10/14). Its guard compares source against `db8b7f0`, so report-only commits do not block it. **It still calls `restart.mjs --maintenance-approved veneer-pro-runner veneer-pro` (runner first).** Only its owner can change it; this packet does not touch it. Until the owner re-arms it with `veneer-pro veneer-pro-runner` or records that runner-first is accepted, the order is unreconciled. Any earlier window must be run by that same owner, after stopping the waiter, so that two executors never exist.

**Approval scope is the whole cumulative set.** An approval for BUILD801 alone does not cover this restart. The restart installs all seven commits `1b8561a..db8b7f0`, and the approval must name them:

| commit | build | change |
|---|---|---|
| `f9c59dd` | #790 | Give every registered bot a bot lane by default |
| `ebf83cf` | held #790-era | Preserve exact QBO receipt replay after terminal reconciliation |
| `ef04461` | held #790-era | Deliver human decision answers ahead of background admission |
| `10cb103` | held #790-era | Keep the redacted receiver error body on failed James webhook pushes |
| `1653378` | #801 | Recover unrelated purchasing after interrupted runs (+ migration 0178 `a6205c95…0877`) |
| `274e669` | #804 | Track QBO phases and bind private helper invocations to native scope (+ migration 0179 `ec134af0…ef5f`) |
| `db8b7f0` | #806 | Track nonfinancial custom directions in the custom-direction tracker |

0178 and 0179 are both pending and are both applied by this one restart. The original Sage recovery review and the UNKNOWN exclusions (`2080773d…`, `ae219af0…`) are outside this deployment. They stay with Sage and the BUILD801 owner and are not approved, released or replayed by it.

**The verified-prior-artifact gate is not met.** The executables now running (web pid 89325, runner pid 34641) were never retained and cannot be proven. `1b8561a` is a reconstruction rebuilt from source. Its only proof is that it opens and migrates a disposable DB copy with every new and legacy ledger empty (section 8, sections 10–11). It has not booted, its full suite was not re-run, and it is not the prior healthy artifact. This is a **material limitation** that the approver must accept knowingly; it is not fulfillment of the gate. Nothing in this packet should be read as rollback assurance beyond that.

## 13. Re-pin for cumulative source 155b497 (#812), 22:44–22:48Z (read-only)

Build queue #813, requested by the BUILD812 owner (chat 732adce5). No restart, recovery, QBO/provider call, source edit or queue move was made. The live DB was not opened; only a hash-verified temporary copy of the backup was used and then deleted.

**Source pin.**

| | |
|---|---|
| main / origin/main | `155b49718ccfe5179fc25650d124cdaa1b91acc4`; tracked tree clean; development lock free at start |
| `git diff 155b497 HEAD -- server web browser-manager installer scripts package*.json` | empty |
| `git diff db8b7f0 155b497` | only `server/src/featureGuide/catalog.ts`, `server/src/qbo/helperProcess.ts`, `server/src/qbo/phaseBoundary.ts`, `server/test/qboPhases.test.ts`. No migration, route, contract or production-wiring change |
| Pending migrations | unchanged: 0178 `a6205c95…0877`, 0179 `ec134af0060f5172723d00c8de2f71263be537e683b3a891ed137e3905ef0e5f` (source and dist identical) |

**Artifact pin (live dist, rebuilt by #812 at 18:43:11 ET server / 18:43:25 ET web).**

| Artifact | Files | Manifest sha256 |
|---|---|---|
| `server/dist` | 577 | `48a578124daf6b2af4547b2b6a4726d71775f48c259013989911a849ebbcef1a` → [manifest-server-dist-155b497.sha256](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-server-dist-155b497.sha256) |
| `web/dist` | 2529 | `02d52cae934a7d5293545b63a310232f93d6d12263bb44a8a6d0abaee9565983` (same as the 7a74def pin) → [manifest-web-dist-155b497.sha256](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/manifest-web-dist-155b497.sha256) |

- Versus the 7a74def manifest, exactly three server files changed: `featureGuide/catalog.js`, `qbo/helperProcess.js`, `qbo/phaseBoundary.js`. The db8b7f0 manifests are kept as historical.
- Clean rebuild of `155b497` in a trap-cleaned `/tmp` worktree ([build-repro-155b497.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-repro-155b497.log)): build exit 0. `server/dist` is **byte-identical** to live (577/577, same manifest sha). All 505 rebuilt `web/dist` files are present and identical in live.
- Recorded hashes (rebuild = live):
  - `qbo/phaseBoundary.js` `687ac2096717ee659b828adb681e05a5f3340388f579bb1ddc667d3cd021fd48`
  - `qbo/phaseContract.js` `1837a7ca7736d7ad69e7fac5b30a24e388fb3a3b86e2df47e38bd55b6760c131`
  - `qbo/helperProcess.js` `cfd4b8d4e35e81e8af15b57e6fc60dd0f7fe9b9dc01c72de26f9e60f02ac72c7`
  - `db/migrations/0179_qbo_phase_transport.sql` `ec134af0060f5172723d00c8de2f71263be537e683b3a891ed137e3905ef0e5f`
- New forward bundle: `~/.local/share/veneer-pro-predeploy/build806-20261013/forward-155b497-live-dist.tgz`, sha256 `8b0041897066a7951421c9c6285e8d99b83a0f352a41d402db57ca16643588fb` (0600), [forward-bundle-155b497.sha256](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/forward-bundle-155b497.sha256). Extracted and verified against both 155b497 manifests. The old `forward-7a74def-live-dist.tgz` (`a85fc0ff…3cae`) and the rollback bundle (`df45cfd5…ca18`) are kept and re-verified OK.

**Source validation evidence (reused, not re-run).** The #812 receipt [validation.json](/Users/archerclawdington/veneer-os/docs/reports/qbo-boundary/build812/validation.json) is the cumulative-source full suite at `155b497`, sequential single worker under the host lock: typecheck pass; `npm test` installer 32, server 4056 passed / 16 skipped (299 files), web 1015 (146 files), browser-manager 52; `npm run build` pass; `git diff --check` pass. The source has not moved since, so the suite was not repeated. This turn ran only one isolated build under the host lock, with nothing overlapping.

**Disposable rollback runtime check** ([disposable-rollback-check-155b497.sh](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check-155b497.sh), [log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check-155b497.log)), 22:47:31–22:47:37Z, on a fresh temp copy of the 21:39:53Z backup that matched sha256 `168bddce709f7075b220e323916b433dbd5866475ed06379275eeef0f6ed11b7`:
- Live `server/dist` matched the 155b497 manifest before the run.
- A: live 155b497 artifact `openDb` ok (wal, fk=1); 0178/0179 applied with the pinned hashes.
- B: rollback 1b8561a (bundle hash and manifests verified) `openDb` ok twice on the migrated copy.
- C: re-forward `openDb` ok.
- A = B = C on every postcheck hash line; all five new ledgers 0 rows; fk-violations 0. All four hash files are identical to the db8b7f0 run (section 8). The temp copy was deleted by the script's trap.

**Approval scope is now eight commits `1b8561a..155b497`.** The section 12 table plus:

| commit | build | change |
|---|---|---|
| `f9c59dd` | #790 | Give every registered bot a bot lane by default |
| `ebf83cf` | held #790-era | Preserve exact QBO receipt replay after terminal reconciliation |
| `ef04461` | held #790-era | Deliver human decision answers ahead of background admission |
| `10cb103` | held #790-era | Keep the redacted receiver error body on failed James webhook pushes |
| `1653378` | #801 | Recover unrelated purchasing after interrupted runs (+ migration 0178) |
| `274e669` | #804 | Track QBO phases and bind private helper invocations to native scope (+ migration 0179) |
| `db8b7f0` | #806 | Track nonfinancial custom directions in the custom-direction tracker |
| `155b497` | #812 | Bind QBO helper execution identity and phase chronology (helper UID checks, monotonic phase chronology, immutable dispatch-start bound, guide) |

An approval naming only `db8b7f0` or any subset does not cover this restart.

**Still unmet or open.**
- The prior-runtime gate is still unmet. `1b8561a` is reconstructed from source; its only proof is the empty-ledger bound above. It has not booted and is not the prior healthy artifact. The approver must accept this limitation knowingly.
- Still open: the registered-caller v2 read probe (section 11), end-to-end probes, timeout persistence, frozen runtime/parent custody, and authoritative adapters. #812's UID, clock and dispatch-bound tests do not establish timeout persistence or runtime/parent custody.

**Before any approved restart.**
- Retake the backup within 15 minutes before the restart (section 5 method, new timestamped file). The 21:39:53Z backup is only the disposable-check source.
- Recheck that `git diff 155b497 HEAD -- server web browser-manager installer scripts package*.json` is empty and both dist manifests match the 155b497 manifests above. Any difference means stop and re-validate.
- Order stays web then runner: `npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner`, run once by a single executor, with section 6 UNKNOWN handling.


## 14. Gate resolution and owners, 23:10Z (read-only; supersedes conflicting text in sections 6, 7 and 12)

State at 23:09Z: HEAD `e4fe077`, report-only since `155b497`; tracked tree clean; no host development lock; no Veneer build running or queued. No `overnight*`/`wait-and-restart` process is running; the scripts in `/tmp/veneer-790/` are inert files. **No executor is armed.**

**Gate 1. Verified prior-runtime rollback: impossible, not satisfiable.** The bytes loaded by web pid 89325 and runner pid 34641 were overwritten in place before any copy was kept. They cannot be read back from disk, rebuilt to a provable match (the exact commits are unknown), or captured from a live process. No sanctioned check can turn `1b8561a` into "the prior healthy artifact." The strongest feasible extra evidence would be booting `1b8561a` web and runner in an isolated DATA_DIR on a disposable DB copy with no credentials and with schedulers disabled. That is new technical work: it needs its own queue slot, and even then it proves only the reconstruction. It is **not** being started. Acceptance of the limitation must be recorded as *accepted limitation*, never as *verified*.
- Owner of the gap statement: a6e39d6e (this packet).
- Owner of the decision whether the gap blocks: the BUILD801 reviewer (BUILD801 owner 6a752161 and its reviewer). If they require the isolated boot anyway, a6e39d6e queues it through the normal queue.

**Gate 2. End-to-end installation probe: authenticated read-only only.** Section 6's "#806 readback via `record_custom_direction_review`" is withdrawn as installation smoke. That write stays with Archer's normal business work after deployment and is not evidence of installation. The installation probe after `restart.mjs --health-check` and `postcheck.sh`:
1. a6e39d6e starts one fresh turn on the new runner. In that turn it calls read-only tools only: `list_build_queue` and `inspect_custom_direction` for decision 0f24e56b, which reads the #806 code path without writing.
2. Record the turn id, the runner pid that served it, and that both tool results returned. Read row counts of `bot_custom_direction_reviews`, `_amendments`, `_progress` and `_fences` before and after; they must be unchanged (`inspect` runs `collect()` in `server/src/bots/customDirection.ts:106`, which has no INSERT/UPDATE/DELETE).
- Owner: a6e39d6e.

**Gate 3. Executor and order.** One executor: a6e39d6e, inside a window approved in Nick's own words. Command: `npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner` (web then runner), run once, with section 6 UNKNOWN handling. No waiter may be armed by anyone for this set. If 852806d0 re-arms one, executor ownership is unresolved again, and this packet stops until it is settled.
- Owner: a6e39d6e. Confirmation needed from 852806d0 that it will not re-arm.

**Gate 4. Registered native pure-read caller (QBO v2).** Plan is unchanged from section 11. One active registered bot, in its own session and with its own token, POSTs `/api/qbo/v2/read` once after the restart. No minted or borrowed token.
- Owner who names the bot and its session: 732adce5 (#804/#812).
- If none runs, record *runtime lookup: unverified*.
- QBO operational acceptance stays open: unavailable resolver, no helper transport, timeout persistence, runtime/parent custody, authoritative adapters.

**Before any human permission question:** gate 1 decision recorded by the BUILD801 reviewer, a named caller for gate 4 (or an explicit acceptance of *unverified*), and 852806d0's no-re-arm confirmation. Readiness stays withdrawn until then.

## 15. Gate 4 status from the QBO contract owner (732adce5 #804/#812), recorded 2026-10-13 (read-only)

- **Registered native lookup caller: UNASSIGNED. Runtime lookup: UNVERIFIED.** 732adce5 reports that it cannot name a willing, eligible caller. Its owner readback and workspace search found no acceptance by any existing registered bot, and being eligible for registration does not show that a bot is willing. No bot is assigned, and no acceptance is claimed.
- **Gate 4 stays unresolved in this packet.** This is a concrete statement that no caller is available, not a readiness claim. Any maintenance question must show it as open. Approving the restart must not be taken as accepting *unverified*, unless the approver says so explicitly.
- **The deferred plan is unchanged (sections 11 and 14).** It runs only after an explicitly approved installation, the schema verification and `postcheck.sh`:
  1. 806 reads the counts of the three QBO v2 tables.
  2. One existing active registered bot that has explicitly accepted runs `POST /api/qbo/v2/read` once, in its own session, with its own credential and a fresh requestKey.
  3. Required result: ABSENT/ABSENT, `phases:[]`, `observation:null`, and all four entitlement fields false.
  4. 806 re-reads the counts; they must be unchanged.
- **What does not substitute for it:** an HTTP health check replaces neither this probe nor gate 2. No minted or borrowed credential, registration, grant, provider request, invoke, reconcile, recovery or restart.
- **Owners:** 806 (a6e39d6e) owns deployment and postcheck; 804/812 (732adce5) owns the QBO contract.
- **Pending regardless of the lookup:** timeout persistence, sanctioned-parent and frozen-runtime custody, and authoritative adapters.

## 16. Build #814: isolated boot of reconstructed 1b8561a. STOPPED at the isolation gate (no boot), with a non-boot fallback on a fresh live-state copy, 23:22–23:30Z

Requested by the BUILD801 reviewer; owner a6e39d6e. This is validation only. Not done: source change, live dist change, restart, deploy, registration, token use or queue reordering. Production services, pid files, launchd and the live DB were not touched; the live DB was only read through the SQLite backup API on a read-only connection. At slot start the development lock was free and no other Veneer build was active (#811 in the separate ERVP queue was failed). Web pid 98183 and runner on 3101 answered `/healthz` healthy before the work.

**Labeling.** `1b8561a` is a reconstruction rebuilt from source. It is not the prior healthy runtime, and nothing here verifies a prior-runtime rollback. **Gate 1 stays UNMET.** At most, this evidence can support a later explicit human acceptance of that limitation. Readiness stays withdrawn.

### 16.1 Isolation design (read-only, from `git show 1b8561a:…`): blocker found, boot not performed

The brief requires disabling every boot-time consumer through existing config flags only, and stopping if that is impossible. `server/src/config.ts` at 1b8561a has **no flag to disable any scheduler or consumer**. The only relevant inputs are ports, `DATA_DIR`, `HOME`/`VP_ENV_FILE` (env file), identity and credentials. Every consumer below starts unconditionally:

| process | started at boot (1b8561a) | effect against a copy of live data |
|---|---|---|
| web | `index.ts:88-89` Doppler refresh + periodic start | Doppler fetch if a token store exists in DATA_DIR |
| web | `index.ts:136` Supermemory provisioner | Provisioning / loopback calls |
| web | `index.ts:177` page expiry | R2 deletes when Pages is configured |
| web | `index.ts:194` generated-file backfill (10 s) | Workspace scans at absolute live paths |
| web | `index.ts:199` `startBotWorkflows`: routines, stale-question withdraw, question rechecks, decision escalation, bot calls (`startPhoneCall`), notifications/push, search, calendar reminder worker | DB writes, Twilio calls, web push, Composio calendar reads |
| web | `index.ts:200` `startJamesLink` | Webhook pushes to James |
| runner | `runner/index.ts:69` Doppler refresh | as above |
| runner | `runner/index.ts:133` `veneerBrowser.reconcile()` | Calls the browser manager (loopback 7301, live) |
| runner | `runner/index.ts:205` spare scheduler | Claude/Codex usage reads with stored accounts |
| runner | `runner/index.ts:206` `resumeInterruptedTurns()` | Re-runs copied pending turns, spawning provider CLIs with cwd at live workspace paths |
| runner | `runner/index.ts:210-211` transcript sweep / retention | Writes under HOME |
| runner | `runner/index.ts:212-215` scheduled tasks, conversation wakeups, **build queue**, huddles | Dispatches copied tasks, wakes and queued builds as agent turns |

Mitigations that need no source change were considered and are feasible in part:
- An empty temp `HOME`/`VP_SERVICE_HOME`/`DATA_DIR` holding only the DB copy.
- `VP_ENV_FILE` pointing at a missing file.
- Unused loopback ports.
- `sandbox-exec` (present at `/usr/bin/sandbox-exec`), with network-outbound denied except named loopback ports and file-write denied outside the temp tree.

They do **not** satisfy the brief's condition, for two reasons:
1. The consumers are not disabled. They would run against copied business state: pending turns, wakeups, scheduled tasks, build-queue rows, routines and decisions. Those rows carry absolute paths into live workspaces, and the runner would spawn agent CLIs from them.
2. An empty `HOME` does not prove the absence of credentials. macOS login-keychain items are per user, not per `HOME`, so a spawned provider CLI may still find a credential. The sandbox then becomes the only barrier against outbound effects.

Disabling these consumers would mean a source change, such as a boot flag or a stripped-down entry point, or mutating the DB copy so it no longer matches live. Both are outside this build. **Per the brief, the boot was not run.** This is the blocker to report.

### 16.2 Non-boot fallback actually run: DB open/migrate path only, against a DB that already holds 0178/0179 exactly as live

- **Fresh online backup** at slot start: `~/.local/share/veneer-pro-predeploy/build806-20261013/veneer-pro-online-20261013T232347Z.db`.
  - Method: better-sqlite3 backup API, read-only source connection, new file.
  - File mode 0600 in the 0700 predeploy directory; it is not in `veneer-pro-backups`.
  - Size 1,108,135,936 bytes; sha256 `601a8c18cdc235f05e0b5a01227eabf5c3e264a1c5bda9a74362e12bbf049b9a`. The hash was re-verified unchanged after the check.
- **Check:** [disposable-rollback-check-814.sh](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check-814.sh), [log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disposable-rollback-check-814.log). It ran on a temp copy (hash-matched to the backup) that a trap deleted afterwards.
  - Fresh copy before the check:
    - `integrity_check` ok.
    - Migrations through 0179, with 0178 `a6205c95…0877` and 0179 `ec134af0…ef5f`.
    - 5 new tables and 10 triggers present.
    - All five new ledgers 0 rows; legacy `qbo_operation_reservations` 0 and `qbo_operation_receipts` 0.
    - FK violations 0.
  - Postcheck hash lines on the fresh copy are identical to the live pin taken after the respawn ([pin-live-after-respawn-20261013T232145Z.hashes.txt](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/pin-live-after-respawn-20261013T232145Z.hashes.txt)). They are also identical to the 155b497 disposable forward run (`disp-A-forward-155b497`). So the BUILD801 run/task/batch/worker-start/exclusion pins are unchanged.
  - Rollback bundle: sha256 `df45cfd5…ca18` OK, and it matches both rollback manifests. The newest migration it carries is 0177.
  - **B / B2:** the reconstructed 1b8561a `openDb` on the live-state copy, run twice: `openDb ok journal=wal fk=1 migrations=181`, exit 0, no DRIFT and nothing pending.
  - Afterwards `integrity_check` was ok, and the postcheck hash lines are **identical** to the before-run ([disp-814-0-fresh.hashes.txt](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disp-814-0-fresh.hashes.txt) = [disp-814-B-rollback.hashes.txt](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/disp-814-B-rollback.hashes.txt)). No writes reached recovery, review or QBO tables.
- **Not measured, because there was no boot:** `/healthz` for 1b8561a web or runner, boot logs, scheduler or consumer start, outbound attempts.

**Limit of this proof (unchanged in kind from section 8).** It exercises the reconstructed candidate's DB open and migrate path against the DB state that live now has. It does not boot the old web or runner, and it is not the running bytes.

### 16.3 Cleanup proof

- The temp tree `/tmp/b814-disp.*` was removed by the trap; a later `ls` finds no match.
- No process was started apart from the two short-lived `node` openDb invocations and `sqlite3`/`shasum`. Nothing was left running.
- Retained: the fresh backup and its `.sha256` (predeploy dir, 0600), the raw `disp-814-*.txt` (predeploy dir, 0600), plus the hash-only files, script and log committed here.

### 16.4 What would unblock a real isolated boot (not started; needs its own decision and queue slot)

Either of these would do:
- A source change adding an explicit isolated-boot mode that skips every consumer in 16.1. It would have to be reviewed and then built into a separate copy of 1b8561a, which makes the result no longer the reconstructed bundle byte for byte.
- Explicit reviewer acceptance of an unflagged boot against a DB copy whose dispatchable rows (pending turns, wakeups, scheduled tasks, build queue, routines, call and notification queues) are neutralized first, under a sandbox that denies non-loopback network and writes outside the temp tree. That proves less than "exactly as live".

The decision belongs to the BUILD801 reviewer. Gate 1 remains UNMET either way.

## 17. Build #815: web crash repair (undici `setTypeOfService` EINVAL), commit `929ae3e`, 23:35–00:05Z. Source only; live dist NOT rebuilt

Requested by the BUILD801 owner (6a752161, thread 73489c19); owner a6e39d6e. Not done: restart, rollback, restore, recovery or queue change. Sage's UNKNOWN custody and the BUILD801 exclusions are untouched. Readiness stays withdrawn.

**Root cause.**
- Node v24.21.0's bundled undici, in `writeH1` (`undici:8020-8021`), calls `socket.setTypeOfService(request.typeOfService)` on the first write of every HTTP/1 request. That runs inside the socket `connect` handler (`undici:3337-3342`).
- `net.Socket.prototype.setTypeOfService` throws on any non-Windows error, and undici does not catch it.
- On macOS, `setsockopt(IP_TOS)` returns EINVAL when the peer has already reset the connection. That happens when the reset lands while this process's event loop is stalled between the handshake and the `connect` callback.
- Web has such stalls: synchronous SQLite busy waits (`database is locked` from james-link 23:06–23:19Z) and other synchronous work.
- **Reproduced.** A peer that resets on accept, running out of process, plus a client that stalls 20 ms between requests, gives `UNCAUGHT EINVAL setTypeOfService`. This is now a regression test.
- **History.** 88 web crashes since 2026-09-29, 33 of them since 2026-10-12. Each one respawned web through launchd from the dist on disk. The runner log has none.

**Relation to the RPC failures.** They share a mechanism: outbound loopback sockets failing while web stalls. They do not provably share a trigger.
- 2030 of the 2092 `runner unreachable` lines are `/rpc/status` and 60 are `/rpc/listSessionFiles`. The old message dropped the cause code, so the specific socket error (refused, reset or connect timeout) cannot be recovered from the log.
- Most of these lines are older. Only 0–20 appear between each crash and the next respawn.
- Which peer reset the socket that crashed web is not recorded either; the crash path is in shared undici code used by every fetch.
- A green runner `GET /healthz` does not exercise the authenticated `POST /rpc/*` path.

**Fix (`929ae3e`).**
- `server/src/net/typeOfServiceGuard.ts` wraps `net.Socket.prototype.setTypeOfService` and ignores only `EINVAL` from `syscall:'setTypeOfService'`. Type of service is best effort, and Node already ignores it on Windows.
  - The reset socket then fails its write, and that one request rejects normally (ECONNRESET or EPIPE).
  - Every other error still throws. It logs at most once a minute, with a running count.
  - It is installed first in web, runner, app-runner and terminal entry points.
- Runner RPC client (`server/src/runner/client.ts`):
  - Failures carry the cause code.
  - Only the 13 read-only RPCs in `READ_ONLY_RPCS` retry, once after 200 ms.
  - Effectful RPCs are never re-sent. A refused connection says `not delivered`; any other socket failure says `outcome unknown, read the current state before any retry`.
- New `GET /healthz/runner-rpc` in web runs an authenticated read-only `/rpc/status` probe for an id that matches no chat. It returns 200/503 with `runner_rpc` and latency.
  - `/healthz` itself is unchanged, so `restart.mjs`, `boot-probe` and `boot-smoke` keep their semantics.
- `CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH` was regenerated (`index.ts` is pinned). `VP_CUSTOMER_EMAIL_REGISTRY_FILE` is unset, so no live registration depends on it.

**Validation, under the host lock with a single worker, nothing overlapping.**
- `npm run typecheck` passed.
- `npm test`: installer 32/32, server 4063 passed / 16 skipped (300 files), web 1015 (146 files), browser-manager 52/52.
- `npm run build` ran **only in a trap-cleaned temp worktree at `929ae3e`**: exit 0 ([build-815-isolated.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-815-isolated.log)). The guard is present in all four compiled entry points.
- Live `server/dist` manifest before and after: `48a578124daf6b2af4547b2b6a4726d71775f48c259013989911a849ebbcef1a`, the 155b497 pin, unchanged.
- **Why live dist was not rebuilt:** any rebuild of the shared `server/dist` is an unapproved web deploy at the next crash.

**Effect on the deployment packet.**
- Cumulative source scope is now **`1b8561a..929ae3e`**, nine shipped commits. The 155b497 table in section 13 plus:

| commit | build | change |
|---|---|---|
| `929ae3e` | #815 | Keep services alive when undici's setTypeOfService hits a reset socket (+ runner RPC cause/retry/UNKNOWN reporting, `/healthz/runner-rpc`) |

- Live dist is still the 155b497 artifact, and web pid 98183 runs it. **The crash is not fixed in production.** Web can still crash, and it will keep respawning from that same 155b497 dist until an approved window.
- Before any approved restart, the packet must:
  1. Rebuild `server/dist` and `web/dist` at the then-current source.
  2. Re-pin both manifests and replace the 155b497 guard/source comparisons with the new SHA.
  3. Name all nine commits in the approval.
- Web and runner are the affected services for the crash. App-runner and terminal pick up the guard only when they next restart; they are not in this restart scope.
- After the restart, add `GET /healthz/runner-rpc` = 200 to the readback in section 6. It is a reachability check only; it does not replace gates 2 and 4.
- Gate 1 stays UNMET. No maintenance or window question is asked here.

## 18. Gate 4 transport answer from the QBO contract owner (732adce5 #804/#812), recorded 2026-10-14 (read-only)

**Status unchanged: caller UNASSIGNED (Clara proposed, not accepted), runtime lookup UNVERIFIED.**

**Transport.**
- No native QBO MCP tool exists, and no generic `callApi` agent tool exists either. MCP-only access cannot make the call.
- An eligible bot can make the read only through its normal, permitted local shell/exec tool. It sends a raw loopback HTTP request using its own current session token:
  - That is the token file `toolbox/materialize.ts:139-147` keys by `executionConversationId || conversationId`. It is resolved at call time per `runtime/agentTokenFile.ts`, with the same header as `mcp/agentToolsServer.ts:800-807`.
  - The token is read at request time and kept only in process memory.
  - Server authentication (`qbo/routes.ts:13-23`) is preserved, not bypassed.
- Do not assume the shell inherits MCP environment variables.
- The caller uses only its own exact execution context's token. Never another chat's config or token, a coordination session's use of the main chat token, a minted or copied token, or a database lookup of one. The token never goes on argv, in printed output or in logs.
- Preferred caller: Clara's original registered session. If Clara has no permitted exec path, or cannot establish her own token location, record **transport infeasible with current tools**.
- Clara's eligibility, tool availability and acceptance are all **unverified**.

**Probe (unchanged sequence, now with the transport fixed):**
1. Only after the installation and postcheck constraints are confirmed and Clara has explicitly accepted.
2. 806 reads the three QBO v2 ledger counts.
3. Clara runs one in-memory HTTP client: `POST http://127.0.0.1:3100/api/qbo/v2/read`, a fresh requestKey, redirects disabled, no debug or secret output. It emits only the HTTP status and the sanitized response.
4. Required result: ABSENT/ABSENT, `[]`, `null`, all flags false.
5. 806 re-reads the counts; they must be unchanged.
6. No provider connector, browser cookies, invoke, reconcile, recovery or refresh.

**Precision correction to section 11.** `phaseBoundary.read` is SELECT-only **for the QBO ledgers**. The shared `resolveAgentTokenContext` (`runtime/agentTokens.ts:52`) runs `DELETE FROM agent_tokens WHERE expires_at < now` on every authenticated call. The HTTP path is therefore not "zero DB writes" overall; the probe's no-change proof covers only the three QBO ledgers.

**Not installation evidence.** Section 17 records that #815 owns the crash repair. The web respawn onto the 155b497 dist, with 0178/0179 recorded live at 22:54:59Z and 22:55:01Z, does not satisfy the approved-installation, postcheck or caller-acceptance constraints. The #812 receipt stays historical. Still pending: timeout persistence, parent/runtime custody, adapters and runtime acceptance.

## 19. Gate 3 and gate 4 owner replies, and #815 closeout state, 23:50Z (read-only)

**State after #815.**
- The build queue has no Veneer build, running or queued. The host development lock is absent. The tracked tree is clean at `e2e2b98`.
- `git diff 929ae3e HEAD` over the shipped source paths is empty.
- Live `server/dist` is still `48a57812…cef1a` and `web/dist` is still `02d52cae…5983`: the 155b497 artifact. #815 was not installed.
- Runtime:
  - web pid 98183 started 23:19:52Z. It is a launchd respawn after a crash, running the 155b497 dist. `/healthz` returns 200.
  - runner pid 34641 started 16:05:13Z and runs the old, unretained pre-0176 artifact.
- **Correction to section 17's header:** #815 actually ran 23:35–23:48Z (commits `929ae3e` at 23:46:16Z, `99d90b0` at 23:47:13Z, `e2e2b98` at 23:48:27Z). "00:05Z" was wrong.
- The source is stable at `929ae3e`, but a re-pin of the deployable artifact has to wait for an approved window. Rebuilding the shared dist now would make the next web crash respawn into an unapproved deploy (section 17). The 155b497 evidence in section 13 stays as historical record.

**Gate 3. Reply from 852806d0, thread 9d6d01d1, 23:20:32Z, verbatim:**
> (a): I will not re-arm or run any waiter or restart for 1b8561a..155b497 (no waiter is running now). a6e39d6e is the single executor, web then runner, only in a window Nick approves in his own words.

- Closed for the 155b497 scope.
- The cumulative scope is now `..929ae3e`. The commitment does not name it, but it covers any waiter or restart "for this cumulative set". No waiter process is running at 23:50Z.
- Treat it as closed unless 852806d0 says otherwise. I will not send a re-ask just to widen the SHA wording.

**Gate 4. Reply from Clara (7f83ff8e), thread 0ad0e4a8, 23:21:17Z, verbatim:**
> Willing. I don't yet know whether this session can make an authenticated local API call with its own agent token. I'll make no call before the future approved restart and won't print, share, or borrow a token.

- Supersedes section 18's "Clara proposed, not accepted".
- Caller: **Clara, willing**.
- Eligibility: active `bot_registrations` row present.
- Transport feasibility, i.e. a permitted exec path and the location of her own token file, is **UNVERIFIED**.
- Runtime lookup: **UNVERIFIED**.
- Section 18's transport is the only allowed path. If at probe time Clara cannot establish her own token location through permitted tools, record *transport infeasible with current tools*.
- Owner of the transport answer: 732adce5. Owner of the read in her own session: Clara.

**Still open:**
- Gate 1, the prior-runtime rollback gate: UNMET. The decision belongs to the BUILD801 owner 6a752161 and its reviewer.
- Gate 4 transport and the runtime lookup: unverified.
- The QBO operational acceptance gaps in section 18.
- The rebuild and re-pin at the then-current source inside any approved window (section 17).

Readiness stays withdrawn.

## 20. Build #816: respawn artifact pinning and browser-manager guard, commit `9b6424e`. Source only; nothing activated, live dist NOT rebuilt

Requested in BUILD801 coordination thread 60a12836 (fce19860); owner a6e39d6e. Not done: restart, rollback, DB restore, recovery, runner restart, live dist rebuild or queue change. Migration hashes (0178 `a6205c95…0877`, 0179 `ec134af0…ef5f`), the empty new and legacy QBO ledgers and the BUILD801 exclusions (`2080773d…`, `ae219af0…`) were not touched; this build did not open the live DB.

**Incident adopted** (BUILD801 coordination): an unapproved, crash-induced partial deployment.
- Web crashed on undici `setTypeOfService` EINVAL, and launchd respawned it from the rebuilt-in-place 155b497 `server/dist`.
- The 22:54:59Z / 22:55:01Z respawn recorded 0178/0179 live; the hashes match the pins.
- Web pid 98183 has run 155b497 since 23:19:52Z. Runner pid 34641 still runs the old, unretained artifact.

**Root cause of the unapproved activation, which is also gate 1's root cause.**
- The web, runner, app-runner, term and web-watchdog plists launched `__CODE_DIR__/server/dist/*.js` under `KeepAlive`, and `npm run build` rewrites that directory in place.
- So every crash after a build deployed it, and the prior executable was overwritten.

**Fix (`9b6424e`, design in [docs/releases.md](/Users/archerclawdington/veneer-os/docs/releases.md)).**
- `scripts/releases.mjs`:
  - `snapshotRelease` copies the build (`server/dist`, `web/dist`, the package.json files and the provider-runtime files that dist reaches) into the read-only `DATA_DIR/releases/<git12>-<manifest12>/`, with `release.json` and `MANIFEST.sha256`. `node_modules` is linked and the lockfile hash recorded. A snapshot activates nothing.
  - `activateRelease` refuses without `maintenanceApproved` and verifies the release first. It atomically swaps `releases/active/<service>`, keeps the replaced target as `releases/previous/<service>`, and logs to `activations.jsonl`.
  - The CLI (`snapshot | status | list | verify`) cannot activate.
- Plist templates for web, runner, app-runner, term and web-watchdog now launch `__SERVICE_ROOT__/server/dist/...`. The installer renders a service's verified active pointer, and otherwise the checkout path with a WARNING. A release that fails verification is never rendered.
  - `--activate-release --maintenance-approved` is the only installer path that activates; without approval it refuses with exit 2.
  - `--dry-run` renders the same decisions without writing.
  - The watchdog follows web's release.
- `scripts/restart.mjs` (approved restarts only):
  - Snapshots the build, or verifies `--release=<id>` for a rollback.
  - Moves each release-mode service's pointer immediately before signalling that service, after its own safety recheck, so a refused or skipped service never respawns onto an unrestarted release.
  - After health, requires web and runner to report the activated release id; a mismatch is a failed, unverified deployment.
  - Prints the rollback command.
  - Warns loudly for every checkout-mode target, including under `--check`.
- Each service logs `[release] <service> running release <id>` at boot, or a warning that it runs the checkout build in place. Web and runner `/healthz` add `release`; `ok` and status codes are unchanged.
- Crash behavior is unchanged: uncaught errors still exit non-zero, log and respawn. There is no silent refusal; the fallback is the existing checkout behavior, with warnings.
- **Browser manager:** `browser-manager/type-of-service-guard.mjs` is the same narrow guard as `929ae3e` (only `EINVAL` from `syscall:'setTypeOfService'`, everything else rethrown). It is installed first in `manager.mjs`, with a `node --test` regression covering the reset peer plus event-loop stall. Its log holds 758 of these crashes.

**Remaining limits, documented.**
- `node_modules` is not snapshotted; a dependency change still needs a window.
- The browser manager and boot probe run plain checkout source, not part of a build.
- `boot-smoke` still boots the checkout dist in a temp data dir.
- The installer's job reload remains a restart of every job; drain first, as for any restart.
- The repository-guidance file at the repo root (`CLAUDE.md`/`AGENTS.md`, user-owned, not edited) still describes the update flow as `git pull → npm install → npm run build → npm run restart`. Its owner should add: after the first approved `--activate-release`, `npm run build` no longer changes what a crash loads, and the approved restart activates the build. `README.md` was updated.

**Validation, under the host lock with a single worker, nothing overlapping.**
- `npm run typecheck` passed.
- `npm test`: installer 38/38 (6 new release tests, including "a respawn after npm run build still loads the activated bytes" and pointer verification), server 4065 passed / 16 skipped (301 files), web 1015, browser-manager 55/55.
- Read-only production checks:
  - `install-darwin.mjs --dry-run` renders the checkout paths for all five plists, with a WARNING per service.
  - `restart.mjs --check veneer-pro veneer-pro-runner` warns about checkout mode.
  - `releases.mjs status` shows `checkout; active none` for all four.
  - `~/.local/share/veneer-pro/releases` does not exist: nothing was snapshotted or activated in production.
- `npm run build` ran only in a trap-cleaned temp worktree at `9b6424e`: exit 0 ([build-816-isolated.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-816-isolated.log)).
  - Snapshot plus approved-flag activation into a **temp** DATA_DIR gave release `9b6424e9ecb6-15b376c1e71c` (1089 files, verified).
  - Through `releases/active/veneer-pro`, `release.js` reports that id, and `openDb` loads native better-sqlite3 via the module link on an empty temp dir (181 migrations).
  - Writes into the release are refused. No service was booted. The temp tree was removed.
- Live `server/dist` is still `48a57812…cef1a` (155b497). Live services are unchanged: web pid 98183 `/healthz` 200, runner on 3101.

**Cumulative scope is now `1b8561a..9b6424e`.** Shipped commits: the section 13 table, `929ae3e` (#815) and:

| commit | build | change |
|---|---|---|
| `9b6424e` | #816 | Respawn services from immutable approved releases, and guard the browser manager (plists, installer, restart.mjs, releases.mjs, release id on /healthz, browser-manager TOS guard) |

**Effect on any future window.**
- This change alters the launchd templates, so the first deployment of it is `install-darwin.mjs --activate-release --maintenance-approved`, which reloads every job, not only web and runner. That widens the restart scope to all launchd jobs, including browser manager, Chrome, tunnel, backup and boot probe, and the approval must say so.
- Alternatively the approver can deploy the earlier commits with plain `restart.mjs`, leaving release mode inactive (checkout mode, with warnings) and accepting the old respawn hazard for that window.
- After first activation, `releases/previous/<service>` exists only from the second approved activation onward. The first activation still has no verified prior artifact for the currently running bytes:
  - web's 155b497 bytes are retained in `forward-155b497-live-dist.tgz` (`8b004189…`);
  - runner 34641's bytes are not retained.
- Gate 1 stays UNMET for this deployment. The fix only prevents the same gap next time.
- Re-pin at the then-current source inside the window (section 17); approval must enumerate all 10 commits `f9c59dd..9b6424e`.

Readiness stays withdrawn. The human disposition is in [DISPOSITION.md](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/DISPOSITION.md).

## 21. Runner RPC availability reconciliation, 2026-10-14 00:14Z (read-only)

Prompted by a coordination observation that `read_conversation` for the BUILD806 chat returned `runner unreachable (/rpc/status): fetch failed`, while DB and queue tools worked and the runner pid was present. The observer did not give a time.

- **Processes.** Web pid 98183 (started 23:19:52Z) and runner pid 34641 (started 16:05:13Z) are both running. Pid 34641 is listening on 127.0.0.1:3101.
- **Health.** At 00:13:49Z, `GET /healthz` returned 200 on runner (0.4 ms) and on web (1.8 ms). As section 17 says, that is not proof of the authenticated RPC path.
- **Authenticated path, exercised directly.** At 00:14Z, `read_conversation a6e39d6e…` returned the chat's transcript with no RPC error. It runs through web and the runner `/rpc/*` path.
  - This shows RPC was available at 00:14Z, nothing more. It does not prove RPC is continuously available.
  - Live web is the 155b497 dist, which has no `/healthz/runner-rpc`. That endpoint only arrives with #815 (`929ae3e`) once it is installed.
- **Web log** (`veneer-pro.log` has no timestamps, so it is bounded by boot lines):
  - The last 3 `runner unreachable (/rpc/status): fetch failed` lines are at 20034, 20159 and 20322.
  - The last boot line, at 20373, is taken to be pid 98183's 23:19:52Z boot because it is the only later boot line. That is inferred from ordering and is not timestamp-proven.
  - Since that line there are **0** `runner unreachable` lines. The observed failure therefore most likely happened before 23:19:52Z, in an earlier web process before a crash.
  - An unlogged failure in the current process cannot be ruled out.
- **Disposition.** This is consistent with section 17's shared mechanism: loopback socket failures while web stalls, with crash/respawn cycles. Nothing new is needed.
  - The repair is #815 (cause codes, a single read-only retry, explicit not-delivered/UNKNOWN for effectful calls, `/healthz/runner-rpc`). With #816, a respawn can no longer change which bytes load.
  - Both are source only and not installed, so RPC failures can recur until an approved window.
  - After that window, readback adds `GET /healthz/runner-rpc` = 200 (section 17). It does not replace gates 2 and 4.
- **Not re-verified here.** The run/batch/worker-start/exclusion pins and FK 0 rest on section 16.2 and the live pin taken after the respawn. This section did not re-run `postcheck.sh`.
- **No restart, rollback, restore, recovery or UNKNOWN clearing was done. No window or approval is implied. Sage custody is unchanged.**

## 22. Review findings on 9b6424e/130ab32, 2026-10-14 (read-only; owner a6e39d6e)

1. **DISPOSITION.md table count corrected.** It said the partial deployment "added two database tables". Migrations 0178 and 0179 add **five**: `purchase_interrupted_reviews` and `purchase_interrupted_dispositions` (0178), plus `qbo_v2_invocations`, `qbo_v2_phases` and `qbo_bill_observations` (0179). Fixed in this commit.
2. **The first-activation command has no active-turn guard. Confirmed.**
   - `installer/install-darwin.mjs` checks only for the `--maintenance-approved` flag (lines 67–69).
   - It snapshots and activates every pointer (356–360), then bootstraps a helper that reloads **every** launchd job (447–535): web, runner, app-runner, term, web-watchdog, chrome, browser-manager, cloudflared, backup, supermemory and boot-probe.
   - It never calls `assertRunnerRestartSafe`. It therefore does not inherit `restart.mjs`'s whole-plan and per-service refusal while turns are pending.
   - The all-job reload also disrupts occupied browsers/Chrome and the tunnel.
   - The guidance to "drain first" in section 20 is withdrawn as evidence of safe activation.
   - **Repair queued as #817** (owner a6e39d6e):
     - whole-plan refusal before any snapshot or pointer change, and a re-check right before the reload, with pointer restoration if that late check refuses;
     - refusal while any browser is occupied;
     - a bounded reload limited to the release services, plus an exact dry-run listing;
     - #817 will also return the concrete guarded first-activation plan.
   - No source was edited outside that slot.
3. **The checkout-mode restart alternative** (`restart.mjs` without activating a release) still carries the unapproved-respawn hazard: any later `npm run build` goes live at the next crash. It needs its own exact, bounded approval. #817 updates DISPOSITION.md to say so.

**Status.**
- Gate 1: UNMET.
- Gate 4: transport and runtime lookup unverified.
- No window, hold acceptance or deployment approval is inferred.
- Nick will not be asked until #817's plan is reviewable.
- Readiness stays withdrawn.

## 23. Build #817: guarded, bounded first activation, commit `63d0ddb`. Source only; nothing activated, nothing installed

Review finding from BUILD801 coordination thread 60a12836 (fce19860); see section 22, item 2. Owner a6e39d6e. Not done: activation, install run, restart, rollback, DB restore, recovery, live dist rebuild or queue change. 0178/0179 hashes, the empty new and legacy ledgers and the BUILD801 exclusions are untouched. Sage custody is unchanged.

**Repair (`installer/activation-guard.mjs`, `installer/install-darwin.mjs`, `scripts/releases.mjs`).**

1. **Plan first, then a whole-plan refusal before any write.** Every installer run first renders all plists in memory and prints:
   - the exact jobs to reload and why;
   - the jobs it leaves alone although their rendered plists differ;
   - the pending-turn count (read-only);
   - the Veneer Browser occupancy.

   On an installed machine, and always with `--activate-release`, it then calls the shared `assertRunnerRestartSafe` (`scripts/restart-safety.mjs`, not copied) over the whole job list, plus the browser check. It does this **before** any snapshot, pointer move, env or provisioning write, or plist write. A refusal exits 1 with a REFUSED line and "nothing was written, snapshotted or activated". It is not retried.
2. **Final and pre-reload checks, and ordering.** The write phase is `guardedReload`, in this order:
   1. final check;
   2. write the planned plists;
   3. move the pointers (`capturePointers` → `activateRelease`);
   4. pre-reload check;
   5. bootstrap the one-shot reload helper.

   - A crash respawn before step 3 loads the old bytes. Before activation, the loaded jobs still launch the checkout path, and launchd does not re-read a rewritten plist until a reload.
   - If step 4 refuses, or the helper bootstrap fails, plists and active/previous pointers are restored exactly (`restorePointers`). A service with no prior release loses its link again (checkout fallback), and the restoration is logged to `activations.jsonl`.
   - The snapshot is taken after the pre-check. It is inert, and it is refused if the build changed since planning.
3. **Browser occupancy.**
   - Source: the manager's existing authenticated, read-only, loopback `GET /v1/capacity` (`active` excludes warm pool copies). No new endpoint.
   - The bearer token is read from `browser.env` at use time, sent only to that request, and never logged or returned (tested).
   - Any running copy (occupied, held with `keep_open`, or not yet paused), any waiting admission, or an unreadable state refuses.
   - Browser occupancy has no override.
4. **Bounded scope.** `--release-services-only` reloads only release jobs whose plist text changed or whose pointer moves, and skips all provisioning (provider runtimes, env upsert, Doppler, shell profile, browser-manager TLS/identity, agent-browser, update-job removal). Chrome, browser-manager, cloudflared, backup, Supermemory and boot-probe stay loaded and untouched.
5. **Overrides and fallbacks.** `--allow-active-turns` is honored only when given explicitly, and it is documented as human-authorized interruption only. There is no delayed or forced fallback and no watcher. A dry run needs no approval flag and writes nothing.
6. **Template scope of `9b6424e`.**
   - Changed (`git diff --stat 9b6424e^ 9b6424e -- deploy/launchd`): exactly the five release-job templates, `com.veneer.pro`, `.pro.runner`, `.pro.app-runner`, `.pro.term` and `.web-watchdog`, one line each.
   - None of the untouched jobs' templates changed.
   - The production dry run reports `com.veneer.chrome` and `com.veneer.pro.backup` as rendering differently from their installed files. The differences are pre-existing formatting only: blank lines, and a `plutil`-reformatted backup plist that still parses. The bounded plan leaves both out; reloading them would need a separately approved full install.

**Validation**, under the host lock, single worker, nothing overlapping:
- `npm run typecheck` passed.
- `npm test`: installer 46/46 (8 new). The new tests cover:
  - pending-turn refusal at the pre-check and at the final check;
  - no write on an early refusal;
  - exact pointer and plist restoration when a turn arrives after activation;
  - restoration on a helper bootstrap failure;
  - occupied, unknown and 401 browser refusals with no token leakage;
  - the bounded job list;
  - the dry-run plan lines;
  - source ordering.
- Other suites: server 4065 passed / 16 skipped (301 files), web 1015, browser-manager 55.
- `npm run build` ran only in a trap-cleaned temp worktree at `63d0ddb`: exit 0 ([build-817-isolated.log](/Users/archerclawdington/veneer-os/out/build806-deploy-prep/build-817-isolated.log)).
- Live `server/dist` is still `48a57812…cef1a` and web `/healthz` 200. `~/.local/share/veneer-pro/releases` still does not exist.

**Production dry run, read-only, 2026-10-14:** `node installer/install-darwin.mjs --activate-release --release-services-only --dry-run`, exit 0.
- `reload`: `com.veneer.web-watchdog`, `com.veneer.pro`, `com.veneer.pro.app-runner`, `com.veneer.pro.term`, `com.veneer.pro.runner`, each with "plist changed, release pointer moves". This is the helper's order: web first, runner last.
- `NOT reloaded`: `com.veneer.chrome`, `com.veneer.pro.backup` (formatting drift above). Supermemory is skipped (not installed).
- `pending turns 3`, so a real run at that moment would have refused at the pre-check.
- `browsers 0 running working copies, 0 waiting`.
- The rendered paths are `…/releases/active/<service>/server/dist/…`.
- The would-be release id was `d013b61848cb-dirty-…` because the #817 edits were uncommitted at that moment. A real run must show a non-dirty id at the approved HEAD.

### 23.1 Guarded first-activation plan (reviewable; NOT ready, and NOT a request for a window)

**Scope.**
- Jobs: exactly five, `com.veneer.web-watchdog`, `com.veneer.pro` (web), `com.veneer.pro.app-runner`, `com.veneer.pro.term`, `com.veneer.pro.runner`, reloaded in that order by the one-shot helper.
- This is wider than the earlier web+runner plan. App-runner restarts local Mini Apps, and term drops open terminal sessions. The approval must name both, or the activation must first be narrowed by a separately reviewed change (not built).
- Chrome, browser-manager, cloudflared, backup, boot-probe and Supermemory are not touched.
- Commits: the 11 commits `f9c59dd..63d0ddb` (the section 13 table plus `929ae3e`, `9b6424e`, `63d0ddb`).

**Pre-checks, in the window, in order. Any failure means stop; nothing is retried.**
1. Nick's own-words approval, recorded verbatim. It must name the 11 commits, the five jobs, the window, and the accepted gate 1 limitation (no verified prior runtime; see rollback below). Gate 4 is either cleared or explicitly accepted as *unverified*.
2. Source pin: `git status` is clean, and `git diff 63d0ddb HEAD -- server web browser-manager installer scripts deploy package*.json provider-runtimes.json` is empty (or names the approved later SHA).
3. Build at that HEAD under the host lock: `npm run build`. From that moment until activation the checkout-mode hazard applies: a crash loads this, the approved build. Keep the gap short.
4. Re-pin both dist manifests at that HEAD and record them here. The forward bundle is optional; the release snapshot itself becomes the retained artifact.
5. Fresh online backup within 15 minutes, using the section 5 method: `integrity_check` ok, FK 0, sha256 recorded.
6. `postcheck.sh > pin-before-<ts>.txt`. It must show 0178/0179 at the pinned hashes, the 5 new and 2 legacy QBO tables at 0 rows, FK 0, and the BUILD801 pins unchanged.
7. `node installer/install-darwin.mjs --activate-release --release-services-only --dry-run` must show:
   - exactly the five jobs above;
   - a **non-dirty** release id `<HEAD12>-<manifest12>`;
   - `pending turns 0`;
   - `browsers 0 running working copies, 0 waiting`;
   - `NOT reloaded` limited to the known chrome/backup formatting drift.

**Execute once:** `node installer/install-darwin.mjs --activate-release --release-services-only --maintenance-approved`
- It repeats the pre-check, final check and pre-reload check itself. A refusal at any of them is final for that attempt: report it, do not re-run blindly, and re-plan.
- The executor's own turn runs under the runner, so its installer process may be killed when the runner job reloads. The detached helper finishes regardless.

**UNKNOWN handling.** If the result is uncertain (killed, timeout, lost output, exit ≠ 0), do **not** re-run. Read, in order:
1. `node scripts/releases.mjs status` and the tail of `DATA_DIR/releases/activations.jsonl`: which pointers moved, or were restored.
2. `~/Library/Logs/veneer-pro/.launchd-install/status.json` (if present) and the tail of `veneer-install.log`: the helper's per-job outcome.
3. `launchctl print gui/$UID/<label>` for the five jobs (read-only), plus `ps -o pid,lstart,command` against `DATA_DIR/run/*.pid`.
4. `restart.mjs --health-check`, then web and runner `/healthz` `release`.
5. `select name, content_hash from migrations where name >= '0178'` and `pragma foreign_key_check` (read-only).
6. The last 200 log lines of web, runner, app-runner and term: `[release]`, `[migrate]`, DRIFT, boot errors.

Then decide one of: done; a single `npm run restart -- --maintenance-approved <one service>` for exactly the job that did not come back; or rollback (below).

**Postcheck.**
- Web `/healthz` is `ok:true`, and `release` equals the activated id. Runner `/healthz` `release` is the same id. `GET /healthz/runner-rpc` is 200 with `runner_rpc:"healthy"`.
- `releases.mjs status`: all four services are `release` with that active id, and `previous none`.
- Boot logs show `[release] <service> running release <id>` for web, runner, app-runner and term. The web-watchdog runs from `active/veneer-pro`.
- `postcheck.sh` diffed against the before-pin:
  - migrations unchanged;
  - `purchase_interrupted_reviews`/`_dispositions` and `qbo_v2_invocations`/`_phases`/`qbo_bill_observations` at 0;
  - legacy `qbo_operation_reservations`/`_receipts` at 0;
  - FK 0;
  - BUILD801 run/batch/worker-start/exclusion pins unchanged.

  A non-zero recovery or review count means stop and route it to the BUILD801 owner.
- Browser-manager, cloudflared and Chrome pids are unchanged from before the run.
- Then gate 2's read-only probe (section 14), and gate 4 per sections 15, 18 and 19 (Clara, own session) or recorded as *unverified*.
- Report the SHA, release id and new pids in thread 9d6d01d1.

**Rollback.**
- `releases/previous/<service>` does **not** exist after this first activation; it appears only from the second approved activation on. **Gate 1 remains UNMET.**
- Web's current 155b497 bytes are retained only as `forward-155b497-live-dist.tgz` (`8b004189…`). Runner pid 34641's bytes are not retained anywhere, and `1b8561a` is only a reconstruction.
- Any rollback after this activation is therefore a new, separately approved activation of a release built from one of those artifacts, via `restart.mjs --maintenance-approved --release=<id>`. It is not a verified prior-runtime rollback.
- Rolling back never restores the DB and never drops the 0178/0179 ledgers.

Readiness stays withdrawn. Gate 1 is UNMET, and gate 4 transport and runtime lookup are unverified. Nick is not asked until this plan has been reviewed (BUILD801 owner 6a752161 and its reviewer).

## 24. Review of 63d0ddb/3ed76ec (§23.1), 2026-10-14 (read-only; owner a6e39d6e)

The bounded 5-job scope and the pre-write guard are adopted. Three blockers were confirmed read-only and are queued as **#818** (owner a6e39d6e). No source was edited outside that slot.

1. **No per-job idle gate in the helper.**
   - `installer/launchd-reload.mjs` `reloadLaunchdServices` runs bootout/bootstrap for each job with no active-turn or browser re-check before each bootout.
   - The installer's final check happens before the helper is bootstrapped. Web returns before the runner, so a turn or browser admitted in that gap would be interrupted.
   - Required: a whole-plan check plus a check before each service is booted out (or an enforced, reviewed admission hold), stopping on refusal with an exact per-job status. The no-active-override boundary is kept.
2. **Partial failures are not restored.**
   - In `installer/activation-guard.mjs`, `guardedReload` calls `writePlists()` outside the try.
   - `activate()` returns the pointer capture only after `activateRelease` completes, so a throw partway through leaves `pointerUndo` null.
   - The earlier "exact restoration" proof covers only failures after those callbacks return.
   - Required: capture the prior state before any write, restore it exactly on any throw at any step, and inject a failure at every step in the tests.
3. **The executor cannot reach zero pending.**
   - The executor's own turn is a pending row, so the guarded command run from that turn always refuses. It must not exclude its own turn.
   - #818 designs a reachable path. The candidate is a one-shot launchd activation job armed with the approval, release, SHA and deadline:
     - it waits for N consecutive zero-pending reads after the arming turn ends, then runs the per-job-gated reload;
     - at the deadline it exits without acting;
     - it never forces or retries, and it refuses on source, dist or release change.
   - The alternative is a human running the command from a shell that is not a Veneer turn.

**Status.** §23.1's plan is not executable until #818 lands and is reviewed. Gate 1 is UNMET. Gate 4 is unverified. Readiness stays withdrawn. No window question will go to Nick yet.
