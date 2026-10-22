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

Coordinator ruling October21 supersedes the old 720-minute gate and lane-lock reconciliation requirements: LTL disabled+zero unfinished is sufficient to proceed; keep the late full-cycle confirmation before the seal. Direct and All_Order_Review must be disabled FIRST, then drain naturally, then capture custody. No process kill or lock removal. Historical HermesDesktopUpdate-20260805 is Hermes infrastructure, not Tier C; disable at step5 and remove after verified seal.

Fresh12:48ET Step2 readbacks allfour passed disabled/same last_run/execution IDs/counts/selected+ALLprofile unfinished0. Step2 proceed gate VERIFIED under revised authority. The separate 22:09ET late LTL wake remains pending and must confirm before any seal verdict.

Step3 tasks disabled ONCE: Direct16:49:12.6996855Z; All_Order_Review16:49:13.3415295Z. Both were Ready, before/after process trees empty. New COM scheduler instance/process checks immediately before and after custody confirmed zero running instances or cycle processes. No process was killed. No lock file or directory was removed. Exact launcher/XML hashes and disable timestamps recorded.

Final custody captured in PC-only backups/hermes-phase2b-20261021/step03/final-custody. Eight original state files plus consistent vendor-governance.sqlite3 snapshot retained; SQLite integrity OK. All_Order_Review every-order-review.json ledger/checkpoint preserved. Sanitized candidates78, commands843, lane groups393 and source hashes/mtimes retained. Outbox467 rows:417delivered/50failed_ambiguous. Dometic pending file active_count33; vendor ledger separately has6Lippert submitted_pending_verification+2needs_manual_reconcile, and additional unresolved Dometic statuses. These are historical stored outcomes, not evidence of live processes; nothing was cleared or retried. See step03-sage-pending-delta.json and full sanitized metadata receipts. Customer bodies and database payload stay PC.

Step3 VERIFIED at17:04:59.8356174Z after946+seconds: both tasks disabled, last_run unchanged, no COM scheduler instances or cycle process tree. Final observation receipt step03-observation-verdict.json. No stop, kill or custody capture repeated.

Step4 vault drift48352e1e4b39 disabled ONCE17:07:12.426231Z under scheduler lock with selected/ALLprofile unfinished0. Brain Backup disabled ONCE17:07:14.7951913Z with zero running scheduler instances/backup processes. Task XML preserved onPC with SHA91D19B86D22345D9A4E0530741E7C405D784E66EDB1044DB4939AD475AB872DF. Existing Brain last_run11:20:22ET/last_result1 retained; no repair or job execution. Source launcher leads to HermesBrainOps/Sync-HermesBrain.ps1. Bounded state includes vault Backup Status.json plus latest five backup-log hashes/mtimes. Two exact Generated manifest paths were absent (recorded, not treated as proof of missing archive scope). Before/disabled comparison: only live HermesOps heartbeat changed; captured backup status/logs/scripts and lifecycle unchanged.

At13:37:58ET vault drift PASSED its full30-minute interval after1845.797seconds: disabled, unchanged last_run/recent IDs/execution count, selected and ALLprofile unfinished0. Brain interim at13:37:59ET: disabled, unchanged11:20:22ET last_run and prior result1, zero running instances/processes; full4h still pending. State metadata at13:38ET: only live HermesOps heartbeat changed; all captured BackupStatus/logs/scripts/lifecycle hashes, mtimes and field fingerprints unchanged. See step04-observation-1337.json.

New coordinator ruling: Brain disabled+no in-flight process is sufficient to proceed; full4h readback remains a confirmation folded into the seal, not a Step5 blocker. Fresh15:49ET Brain readback passed disabled/no inflight. Inventory beforeStep5 confirms zero enabledHermescrons.

Step5 manager watchdog disabled19:55:38.0744641Z, active Startup Hermes_Gateway_ervp-manager.vbs renamed .disabled-20261021 with SHA6A0ED801EEACEE8B9054F7389E51A1F72908AFC8F779788121D449F2CA92E806 unchanged. No separate manager gateway was present; no business process was stopped. Runtime status points to shared rootPID11592, preserved until later root/default step. Historical disabledCMD remains untouched. Fresh post-disable preflight confirms no manager gateway, no enabled cron, ALLunfinished0. Original watchdog XML copied onPC/SHA C7603F292CC1F21FD1B64216774ED1D2425253023E1C509AF933CB40AEDAF4EF.

The first isolated manager helper timed out without creating a mutation journal or changing watchdog/launcher. Source readbacks confirmed absence of effects; exact own PowerShellPID15004/creation/parent/encoded-command signature was checked and stopped (only our helper, no business process). Receipt step05-stop-own-helper.json. A replacement narrow script first stopped before mutation on a missing receipt directory; directory creation was corrected, then the current manager-disable.json records the sole actual watchdog disable/launcher rename. Do not repeat either effect. Avoid blindly rerunning the larger generic helper; its stalled invocation had no business effect.

Manager VERIFIED16:20:07ET after1468.375seconds: all observation checks passed, post-observation preflight ALLunfinished0/no enabledcron/taskdependency/no profilegateway, historicaldisabledCMD metadata/hash unchanged. Sharedroot remained untouched.

Orders watchdog disabled20:20:58.1987309Z FIRST, activeStartupVBS renamed .disabled-20261021 SHA9982A6C6D18B6C1B46DCE4E34F0C7895701BC789CB5C3B75387656284138702B, exactgatewayPID20624/parent19060/creation07:12:25.8271720ET stoppedONCE20:20:58.8628469Z. Fresh preflight plus immediate checks activeagents0/ALLunfinished0/noenabledcron/nochildwork/freshheartbeat/exactidentity passed. Task/sourceaction audit confirms gateway-only chain; disabled business dependencies untouched. TaskXML PCcopy SHA48D835A5880D21DD7EAA076D78C5A9D4A821F761B23D56E6F4C8BBF07C818581. Post-disable preflight no gateway/no enabled taskdependency/ALLunfinished0. HistoricaldisabledCMD unchanged. No process other than exact Orders gateway targeted.

Orders VERIFIED16:36:40ET after941.528seconds: all observation checks passed, post-observation preflight ALLunfinished0/no enabledcron/taskdependency/no profilegateway. HistoricaldisabledCMD metadata/hash unchanged.

HermesOps dedicatedwatchdog disabledFIRST20:37:11.0576916Z, exactgatewayPID7544/parent7852/creation07:10:20.8495980ET stoppedONCE20:37:11.7212993Z. Source actionensure-gateway.vbs audited gateway-only; freshpreflight+immediatechecks activeagents0/nochildwork/noenabledcron/ALLunfinished0/heartbeat/exactidentity passed. No activeStartup existed; historicaldisabledVBS untouched/hashFF557BD8EF35DC35D99E6BC250588E5B7DE6B86B13A97FA28862950E1FBB1FAD. HermesOps2watchdogalreadydisabledTierCuntouched. OriginalwatchdogXML PCcopySHA2D70608CFC708830B2FE29609AD004A248212106191E95CC493D721A22B6AC38. Post-disablepreflight no gateway/noenabledtaskdependency/ALLunfinished0/historicalstartupentiremetadataunchanged.

HermesOps VERIFIED16:52:45ET after933.474seconds: all observation checks passed, post-observation preflight ALLunfinished0/no enabledcron/taskdependency/no gateway. HistoricaldisabledVBS entiremetadata/hash unchanged; disabledHermesOps2task untouched.

Root/default actualhome C:/Users/nicho/AppData/Local/hermes confirmed by sourceHERMES_HOME/defaultHERMES_PROFILE. Rootgateway_state.json is staleJunePID18612 and was NOT used as current work proof. Matching manager runtimePID11592/activeagents0 and fresh heartbeatPID11592, nochildwork, exactprocessPID11592/parent7940/creation07:10:19.6363930ET, root+managerledgersALLunfinished0/noenabledcron passed. RootHermes_Gatewaytask disabledFIRST20:53:53.9757914Z; exactPID11592 stoppedONCE20:53:54.6361906Z. NoactiveRootStartup existed, no launcher rename. TaskXML PCcopySHAFE6E8F7E8AB9AC52133F917CEF61F9CCBA0EF656AE3E4E0C2B02AC2DD53361C8. Post-disable rootpreflight no gateway/noenabledtask/noenabledcron/ALLunfinished0. No otherprocess targeted.

Root/default VERIFIED17:09:26ET after932.153seconds: all observationchecks passed, explicitpostpreflightALLunfinished0/no rootgateway/taskdisabled/no enabledrootcron. Brain4h confirmationPASSED21:09:30Z after14535.511seconds: disabled/same11:20:22ETlast_run/result1/no instances/processes; recorded step04-brain-final-verdict.json, no job run.

Accounting-migration watchdogdisabledFIRST21:09:55.9602491Z, activeStartupVBSrenamed.disabled-20261021 SHA0C925C80BDA0D82E49FA7A5F7C792E667C813F38DC1B93138C71E392C76F5359, exactPID15872/parent14348/creation07:10:49.2157360ETstoppedONCE21:09:56.6490934Z. Freshactiveagents0/nochildwork/noenabledcron/ALLunfinished0/heartbeat+identitychecks;sourcegatewayonlyactionaudit. TaskXMLPCcopySHA13C581337D49EAFFD8B7F6A9A25CE1D66A5073CDB10726DE1CAA7BB0519C9900. Postno gateway/taskdependency/ALLunfinished0. HistoricaldisabledCMDuntouched.

HermesDesktopUpdate-20260805 infrastructuretask disabledONCE21:10:17.0007151Z afterReady/no instances/processes; originalXMLPCcopySHA42437C8A8FF623E599003BBCC430A38BEFDACAE7DF9D26EF1CE31238769027C9, updaterScriptSHAB02FB7FA2F88616774EBD077A7E0CF11F88CAEF55870BBA8B7195ABD9AFC7ECC. Last_runAug5/result0 preserved. No update executed.

Fresh INTERIM globalinventory shows zeroenabledHermescron, zeroenabledHermestasks, zeroHermes-relatedprocesses, zeroactiveHermesStartup. RemainingactiveStartupWisprFlow+Tailscale untouched. This is NOT finalStep5 verdict untilaccounting15minpasses. No deletion has occurred.

Step5 VERIFIED at17:25ET: accountingfullobservation930.298secALLcheckspassed/postALLunfinished0/no gateway/deps/historicaldisabledCMDunchanged. Finalglobalinventoryzeroenabledcron/tasks/Hermesprocess/activeHermesStartup; all31root/profileexecutionledgersunfinished0. DesktopUpdate task remainsdisabled. WisprFlow/Tailscale/SSH/sharedruntimes untouched. FormalStep5report sentcoordinatorrequest_keyhermes-pc-operator-phase2b; see [step05-report.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-report.md).

Step6 PC-onlyincrementalrefresh launchedONCE viaWMI PID9904created2026-10-21T17:29:48.0318450-04:00, source C:/Users/nicho/backups/hermes-final-20261016/archive-quiescent.py SHA E8B3E57274661D3F4214E5386B074AE280FF48C15A899C36BABA9424EFC51D4C. Refreshdirquiescent-20261021. PCsyntax/read-onlyguard verifiedzeroall/sourcehash beforelaunch; initialstatusstarting/indexloading/liveidentitymatched/free523513950208bytes. DoNOTrelaunch or editcontroller whilelive. Source/body/manifestsremainPC-only.

Controller preserves original manifests/reports/scope and priorchangedpayload versions, hashes sourcefiles under the approved sixroots/exclusions, makes consistentSQLite snapshots for every detectedheaderregardlessextension, runs incrementalrobocopy/E withoutPURGE ordelete, writescurrentmanifest+addendum, verifiesallSQLitecopies/restoreonefileeachroot/ACL/quiescence. A successful refresh produces refresh_verified_pending_operator_seal, NOT sealed. Independentreadback and lateLTLconfirmation stillrequired before phase3sealedverdict. Anyerrorrequiresinspection/reconciliation; no blind rerun or deletion. The original baseline report remains historical even as changed mirrorpaths refresh; previousversions are retained inquiescent/previous-payload.

At20:40ET the controller was found exited. Status/failure records show failed20:22:56ET with OperationalError; sourceSHA unchanged. NOSEAL/NO DELETION. Read-only audit found committedindex1,120,000files/47SQLite, inventory tail beyond that transaction,66snapshotfiles. The newest snapshot cache.db path265characters returns SQLITE_CANTOPEN14 under normal and extendedURI; its existing152-character Windows8.3shortURI passes integrity_check. This is a proven path-access problem for that snapshot, not a full archive verification. No diagnostic changed payload or ran a business job. No controller relaunched. Preserve failedattempt/index/inventory/snapshots/versions; do not blindretry or overwrite. The stream beyond the committedindex must be reconciled before any future resumable repair.

Hardseal gate failed: all sixsource roots retained, Phase3 deletionNOTSTARTED. Recorded [seal-failure.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase3/seal-failure.md) and [seal-verdict.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase3/seal-verdict.json). Reported coordinator. LateLTL22:09ETconfirmation remains pending but cannot itself verify this failedrefresh. No routine livecontrollerpoll is needed while controller is absent; any follow-up must inspect source/coordination and failedattempt metadata, not relaunchblindly.

## Authorized repair and current resume

The coordinator accepted NOT_VERIFIED/no deletion and explicitly authorized this isolated operator repair. The failed quiescent-20261021 attempt remains preserved. Reconciliation matched all 1,120,000 committed index rows against 1,121,082 inventory records, recovered the 1,082 uncommitted tail records, verified all 66 captured SQLite snapshots and all 77 prior-version hashes, and reported no unresolved gaps. New operator index and reconciliation records are in PC-only quiescent-resume-20261021.

The repair verifies Windows 8.3 aliases against file identity before SQLite access. Where unavailable for a long path, extended-length file handles copy into a short isolated custody path with SHA-256 comparison. New SQLite snapshot destinations are flat, bounded paths. Preflight passed the exact previously failing 265-character snapshot through both the verified short alias and a forced no-8.3 fallback, plus a new consistent-backup integrity check. The quiescence readback was zero enabled cron/tasks, processes and active Startup launchers. No Hermes job ran.

The new launch journal records ONE refresh launch at 2026-10-22T00:51:44Z, PID14696, created2026-10-21T20:51:44.2121200-04:00, sourceSHA6328A72B667B621D04511B2214DC7D77A60E3F3DB8D0F78CF746C5819A20924C. At04:13:41Z Oct22 the repaired controller was absent; sourceSHA unchanged. It failed04:08:18Z with RuntimeError: Prior baseline payload hash mismatch. A bounded read-only audit of the finite previous-payload custody identified mirror/local-hermes/profiles/ervp-orders/workspace/NUL. Extended-length source, mirror and newly preserved history reads all have SHA63a1626b4d619d0a6614f871440e7f72c64347101e40e7ea87082676d5b0ec22 and54bytes; baseline manifest records the empty-file SHAe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. Normal-path history stat reports0bytes, demonstrating reserved-name access ambiguity. No cause of historical hash divergence is attributed. Audit found2,380,000 committed source rows,371version records including the77 reused originals, and295 new history files, one not journaled because the check halted. Both attempts and every captured file remain preserved. No payload repair, rerun, deletion or Hermes job was performed. Stop and report under the explicit failure instruction; no routine controller poll is needed while absent. The seal remains NOT_VERIFIED and deletion is blocked. See archive-resume-failure-audit-final.json and the updated Phase3 seal verdict. Late LTL confirmation PASSED at02:09:29Z Oct22 for both jobs after43,232+seconds: disabled, unchanged last_run/recent execution IDs/counts, zero selected and ALL-profile unfinished, scheduler-locked read-only. See step02-late-ltl-verdict.json. This completes that seal input only; full refresh verification remains pending. No automatic refresh retry is armed after this failure.

## Reserved-name reconciliation authorized October22

After accepting the second failure stop, the coordinator authorized a scoped reserved-device/empty-baseline-row correction addendum and ONE new refresh launch after both stopped attempts reconcile. The existing NOT_VERIFIED verdict continues to block all deletion. No job, restart or source-root change is authorized by this repair.

The PC-only reserved-name audit finished04:34:34Z, preserving both stopped attempts and original manifests. It audited2,758,807 source files and all5,887 empty-SHA baseline rows; exactly ONE correction row, workspace/NUL, has matching54byte source/mirror/history SHA63a1626b4d619d0a6614f871440e7f72c64347101e40e7ea87082676d5b0ec22. New PC baseline-corrections.jsonl SHA684d652d831c70c071ea264f18c6db98deabd45a0f3b113829a576982b57a80f is signed in its own SHA256SUMS. Neither old manifest was edited. Reconciliation matched all2,380,000 committed rows, recovered6,571tail rows, and verified259snapshots/372prior-version records, including the formerly unjournaled NUL custody. No unresolved entries.

Reviewed preflight passed: exact correction values and checksum, preserved prior-record hashes, all259snapshot checks, long-path SQLite regression, correct16byte header detection, three negative tests rejecting unapproved key/baseline/hash mismatches, and freshzeroHermesprocess/enabledcron/tasks/Startup. No Hermes job ran. See archive-r3-preflight.json and archive-r3-reconciliation-read.json.

R3refresh launched ONCE from new journal at04:54:05Z Oct22: PID16716 parent14180 created2026-10-22T00:54:05.2285330-04:00, source archive-quiescent-r3.py SHAFA41B3287CDF40841F23729964D28342AF5A7A3D42F43E8993100356BF2F2A65. Readback11:10:29Z matches exactidentity/hash; archive_hash_header_verification:1,900,000archivefiles/101,774,216,684bytes/213SQLiteallintegrityOK/errors0, no failure/free474833653760bytes. This is partial verification, not a sealed verdict. The prior NUL stopping point has been passed; application receipt records exactly that approved correction and its unchanged addendum SHA. PCdirectoryquiescent-r3-20261022. Do NOT repeat launch or modify live source. It reuses the reconciled index/versions, allows prior-hash mismatch only under the exact checksummed correction row, and otherwise aborts. Original manifests/both attempts remain preserved. Complete six-root no-purge refresh, manifests/addendum, all archive SQLite copies, restore samples, ACL metadata and independent quiescence readback before a new seal. Brain and late LTL inputs remain verified. On third failure STOP/report/no deletion. Current verdict still NOT_VERIFIED until all gates pass; no deletion has started.

A read-only PowerShell metadata projection timed out without a receipt; the bounded Python projection returned the required correction/reconciliation evidence. Exact own helperPID2992/creation00:51:00.599877ET/parent7408 and encoded-wrapper signature were verified, then only that helper was stopped once. Immediate exit readback was transient; fresh final read confirms no remaining matching helper. No Hermes or business process was targeted and no payload was changed. Use the Python projection instead of repeating the stalled PS projection. Receipts archive-r3-stop-own-read-helper.json and archive-r3-helper-final.json.

## Remaining sequence

2. Disable orders vendor failure ce09b813238c, orders LTL b95f03d799dc, root LTL 9b03a939ef99, dev2 Lippert 9868ee5f2643 (unconditional now). Capture actual state first. Both LTL schedules are720minutes, but the revised proceed gate is disabled+zero unfinished; preserve late full-cycle readback before seal, never force a run.
3. VERIFIED: tasks disabled and drained, custody captured, full task-cycle observation passed. Revised sequence is disable task → natural drain/no kill → final custody; no lane-lock ownership requirement beyond no cycle alive. Never remove existing locks or invoke business helpers.
4. Proceed gate VERIFIED: vault30min passed; Brain disabled/noinflight sufficient per new ruling. Brain4h retained as confirmation before seal.
5. Stop remaining gateways serially after watchdog disable and active launcher rename, exact fresh process identity/no in-flight checks, full15min no-relaunch each. Fresh baseline has default/root11592, hermesops7544, accounting-migration15872, orders20624; manager was not live in that inventory; its watchdog is now disabled and verified. Re-discover, never reuse these PIDs blindly. Zero final Hermes processes/enabled cron/enabled tasks/activeStartup. Tier C untouched.
6. Refresh six-root PC-only archive incrementally with no purge/delete, new manifest addendum, every SQLite integrity and restore test; record quiescent seal only after all writers stopped. Prior verified baseline remains preserved.
Phase 3 is approved in advance, exclusively after all quiescent-seal checks pass and a sealed verdict is recorded under phase3/. Then remove tasks/launchers/wrappers and the authorized Hermes roots in the specified order, with original hashes and sizes before/after. Preserve backups/, ervp-vendor-automation, orderops-src, Tailscale, OpenSSH and all non-Hermes assets. See [Phase 3 authority and gated execution plan](/Users/archerclawdington/veneer-os/out/hermes-removal/phase3/README.md). If the seal fails, stop and report without deleting.

## Fresh inventory findings / scope checks

Nine enabled Hermes cron entries match the new list. The two business tasks now trigger every5min(All_Order_Review) and15min(Direct_Shopify); use actual inventory rather than stale prior cadence. Historical one-shot HermesDesktopUpdate-20260805 is explicitly classified Hermes infrastructure by coordinator ruling: disable in step5, preserve original hash, remove in phase3 after verified seal. Other Tier C state remains untouched. No new lane activation is authorized.

Coordinator reports are required under request_key hermes-pc-operator-phase2b after step5, after sealed step6, and with Phase3 source deletion plan. No source builds/restarts are needed. Persist each pending observation/seal wake.

## Artifacts

- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/SHA256SUMS.txt)
- [archive-failure-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-failure-audit.json)
- [archive-failure-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-failure-audit.ps1)
- [archive-failure-audit.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-failure-audit.py)
- [archive-longpath-readonly-probe.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-longpath-readonly-probe.json)
- [archive-longpath-readonly-probe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-longpath-readonly-probe.ps1)
- [archive-quiescent-launch.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-launch.json)
- [archive-quiescent-launch.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-launch.ps1)
- [archive-quiescent-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-preflight.json)
- [archive-quiescent-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-preflight.ps1)
- [archive-quiescent-status-1731.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-1731.json)
- [archive-quiescent-status-1801.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-1801.json)
- [archive-quiescent-status-1832.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-1832.json)
- [archive-quiescent-status-1903.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-1903.json)
- [archive-quiescent-status-1938.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-1938.json)
- [archive-quiescent-status-2009.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-2009.json)
- [archive-quiescent-status-2040.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-2040.json)
- [archive-quiescent-status-start.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status-start.json)
- [archive-quiescent-status.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-status.ps1)
- [archive-quiescent-upload.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-upload.json)
- [archive-quiescent-upload.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent-upload.ps1)
- [archive-quiescent.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-quiescent.py)
- [archive-sqlite-failure-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-sqlite-failure-audit.json)
- [archive-sqlite-failure-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-sqlite-failure-audit.ps1)
- [archive-sqlite-failure-audit.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-sqlite-failure-audit.py)
- [cron-control.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/cron-control.py)
- [gateway-preflight-body.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/gateway-preflight-body.ps1)
- [gateway-stop-body.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/gateway-stop-body.ps1)
- [inventory-all-stopped-interim.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-all-stopped-interim.json)
- [inventory-baseline.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-baseline.json)
- [inventory-before-accounting.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-accounting.json)
- [inventory-before-hermesops.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-hermesops.json)
- [inventory-before-orders.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-orders.json)
- [inventory-before-root.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-root.json)
- [inventory-before-step03.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-step03.json)
- [inventory-before-step05.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-before-step05.json)
- [inventory-manager-pending.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-manager-pending.json)
- [inventory-step05-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/inventory-step05-final.json)
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
- [step02-9868ee5f2643-released-1248.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9868ee5f2643-released-1248.json)
- [step02-9b03a939ef99-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-before.json)
- [step02-9b03a939ef99-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-disable.json)
- [step02-9b03a939ef99-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-disable.ps1)
- [step02-9b03a939ef99-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-observe-1024.json)
- [step02-9b03a939ef99-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-read.ps1)
- [step02-9b03a939ef99-released-1248.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-9b03a939ef99-released-1248.json)
- [step02-b95f03d799dc-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-before.json)
- [step02-b95f03d799dc-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-disable.json)
- [step02-b95f03d799dc-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-disable.ps1)
- [step02-b95f03d799dc-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-observe-1024.json)
- [step02-b95f03d799dc-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-read.ps1)
- [step02-b95f03d799dc-released-1248.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-b95f03d799dc-released-1248.json)
- [step02-ce09b813238c-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-before.json)
- [step02-ce09b813238c-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-disable.json)
- [step02-ce09b813238c-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-disable.ps1)
- [step02-ce09b813238c-observe-1024.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-observe-1024.json)
- [step02-ce09b813238c-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-read.ps1)
- [step02-ce09b813238c-released-1248.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step02-ce09b813238c-released-1248.json)
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
- [step03-custody.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-custody.ps1)
- [step03-custody.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-custody.py)
- [step03-disable-tasks.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-disable-tasks.json)
- [step03-disable-tasks.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-disable-tasks.ps1)
- [step03-drain-after-custody.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-drain-after-custody.json)
- [step03-drain-before-custody.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-drain-before-custody.json)
- [step03-drain.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-drain.ps1)
- [step03-final-delta.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-final-delta.json)
- [step03-final-observation.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-final-observation.json)
- [step03-lock-schema-prep-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep-expanded.json)
- [step03-lock-schema-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.json)
- [step03-lock-schema-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.ps1)
- [step03-lock-schema-prep.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-lock-schema-prep.py)
- [step03-observation-verdict.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-observation-verdict.json)
- [step03-preparation.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-preparation.md)
- [step03-review-paths.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-review-paths.json)
- [step03-review-paths.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-review-paths.ps1)
- [step03-sage-pending-delta.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-sage-pending-delta.json)
- [step03-source-prep-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep-expanded.json)
- [step03-source-prep.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.json)
- [step03-source-prep.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.ps1)
- [step03-source-prep.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-source-prep.py)
- [step03-task-settings.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-task-settings.json)
- [step03-task-settings.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-task-settings.ps1)
- [step03-vendor-projection.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-vendor-projection.json)
- [step03-vendor-projection.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step03-vendor-projection.ps1)
- [step04-brain-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-before.json)
- [step04-brain-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-disable.json)
- [step04-brain-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-disable.ps1)
- [step04-brain-final-verdict.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-final-verdict.json)
- [step04-brain-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-final.json)
- [step04-brain-observe-1337.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-observe-1337.json)
- [step04-brain-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-read.ps1)
- [step04-brain-released-1549.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-brain-released-1549.json)
- [step04-observation-1337.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-observation-1337.json)
- [step04-state-before-expanded.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-before-expanded.json)
- [step04-state-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-before.json)
- [step04-state-disable-delta.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-disable-delta.json)
- [step04-state-disabled.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-disabled.json)
- [step04-state-observe-1337.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-observe-1337.json)
- [step04-state-paths.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-paths.json)
- [step04-state-paths.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state-paths.ps1)
- [step04-state.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state.ps1)
- [step04-state.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-state.py)
- [step04-vault-before.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-vault-before.json)
- [step04-vault-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-vault-disable.json)
- [step04-vault-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-vault-disable.ps1)
- [step04-vault-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-vault-final.json)
- [step04-vault-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step04-vault-read.ps1)
- [step05-accounting-launcher-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-launcher-audit.json)
- [step05-accounting-launcher-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-launcher-audit.ps1)
- [step05-accounting-migration-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-final.json)
- [step05-accounting-migration-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-observe.ps1)
- [step05-accounting-migration-post-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-post-disable.json)
- [step05-accounting-migration-post.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-post.json)
- [step05-accounting-migration-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-preflight.json)
- [step05-accounting-migration-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-preflight.ps1)
- [step05-accounting-migration-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-migration-stop.json)
- [step05-accounting-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-accounting-stop.ps1)
- [step05-desktop-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-desktop-disable.json)
- [step05-desktop-disable.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-desktop-disable.ps1)
- [step05-ervp-manager-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-final.json)
- [step05-ervp-manager-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-observe.ps1)
- [step05-ervp-manager-post-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-post-disable.json)
- [step05-ervp-manager-post.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-post.json)
- [step05-ervp-manager-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-preflight.json)
- [step05-ervp-manager-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-preflight.ps1)
- [step05-ervp-manager-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-stop.json)
- [step05-ervp-manager-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-manager-stop.ps1)
- [step05-ervp-orders-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-final.json)
- [step05-ervp-orders-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-observe.ps1)
- [step05-ervp-orders-post-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-post-disable.json)
- [step05-ervp-orders-post.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-post.json)
- [step05-ervp-orders-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-preflight.json)
- [step05-ervp-orders-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-preflight.ps1)
- [step05-ervp-orders-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-ervp-orders-stop.json)
- [step05-global-check.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-global-check.json)
- [step05-global-check.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-global-check.ps1)
- [step05-global-check.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-global-check.py)
- [step05-hermesops-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-final.json)
- [step05-hermesops-launcher-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-launcher-audit.json)
- [step05-hermesops-launcher-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-launcher-audit.ps1)
- [step05-hermesops-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-observe.ps1)
- [step05-hermesops-post-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-post-disable.json)
- [step05-hermesops-post.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-post.json)
- [step05-hermesops-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-preflight.json)
- [step05-hermesops-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-preflight.ps1)
- [step05-hermesops-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-stop.json)
- [step05-hermesops-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-hermesops-stop.ps1)
- [step05-manager-after-timeout.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-after-timeout.json)
- [step05-manager-cmd-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-cmd-audit.json)
- [step05-manager-cmd-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-cmd-audit.ps1)
- [step05-manager-disable-only.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-disable-only.ps1)
- [step05-manager-effect-read.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-effect-read.json)
- [step05-manager-effect-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-effect-read.ps1)
- [step05-manager-effect-read2.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-effect-read2.json)
- [step05-manager-effect-read2.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-effect-read2.ps1)
- [step05-manager-launcher-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-launcher-audit.json)
- [step05-manager-launcher-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-launcher-audit.ps1)
- [step05-manager-recovery-read.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-recovery-read.json)
- [step05-manager-recovery-read.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-manager-recovery-read.ps1)
- [step05-orders-launcher-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-orders-launcher-audit.json)
- [step05-orders-launcher-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-orders-launcher-audit.ps1)
- [step05-orders-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-orders-stop.ps1)
- [step05-own-helper-identity.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-own-helper-identity.json)
- [step05-own-helper-identity.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-own-helper-identity.ps1)
- [step05-report.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-report.md)
- [step05-root-final.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-final.json)
- [step05-root-home-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-home-audit.json)
- [step05-root-home-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-home-audit.ps1)
- [step05-root-launcher-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-launcher-audit.json)
- [step05-root-launcher-audit.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-launcher-audit.ps1)
- [step05-root-observe.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-observe.ps1)
- [step05-root-post-disable.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-post-disable.json)
- [step05-root-post.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-post.json)
- [step05-root-preflight.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-preflight.json)
- [step05-root-preflight.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-preflight.ps1)
- [step05-root-stop.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-stop.json)
- [step05-root-stop.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-root-stop.ps1)
- [step05-stop-own-helper.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-stop-own-helper.json)
- [step05-stop-own-helper.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/step05-stop-own-helper.ps1)
