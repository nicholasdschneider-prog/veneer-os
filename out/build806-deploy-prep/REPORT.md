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
2. Record the turn id, the runner pid that served it, and that both tool results returned. Read `custom_direction` row counts before and after; they must be unchanged.
- Owner: a6e39d6e.

**Gate 3. Executor and order.** One executor: a6e39d6e, inside a window approved in Nick's own words. Command: `npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner` (web then runner), run once, with section 6 UNKNOWN handling. No waiter may be armed by anyone for this set. If 852806d0 re-arms one, executor ownership is unresolved again, and this packet stops until it is settled.
- Owner: a6e39d6e. Confirmation needed from 852806d0 that it will not re-arm.

**Gate 4. Registered native pure-read caller (QBO v2).** Plan is unchanged from section 11. One active registered bot, in its own session and with its own token, POSTs `/api/qbo/v2/read` once after the restart. No minted or borrowed token.
- Owner who names the bot and its session: 732adce5 (#804/#812).
- If none runs, record *runtime lookup: unverified*.
- QBO operational acceptance stays open: unavailable resolver, no helper transport, timeout persistence, runtime/parent custody, authoritative adapters.

**Before any human permission question:** gate 1 decision recorded by the BUILD801 reviewer, a named caller for gate 4 (or an explicit acceptance of *unverified*), and 852806d0's no-re-arm confirmation. Readiness stays withdrawn until then.
