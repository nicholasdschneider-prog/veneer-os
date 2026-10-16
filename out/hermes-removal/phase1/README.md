# Hermes PC Phase 1 — read-only findings, October 16, 2026

Windows inventory captured 2026-10-16T08:03:17.8476352-04:00 on MINIPC-9OB1Z, via Nick’s authorized SSH identity. This phase made no PC-side file changes, stops, disables, renames, job invocations, archive creation, uninstalls, or deletions. Local report/probe artifacts were created on the Mac. No credentials, DPAPI blobs, session database contents, or customer message bodies were returned.

## Inventory and scope

- 12 current jobs.json files: 34 current definitions, 18 enabled and 16 disabled. All enabled IDs match the Oct 13 disposition. Cron metadata includes paths, IDs, names, enabled states, schedules, and available next/last-run fields; prompts and job commands are withheld.
- 26 matching Windows tasks: 21 enabled, 5 disabled. Triggers, repetition intervals, states, last/next runs, results, action executables, and extracted script paths are preserved. Arbitrary action arguments are withheld.
- Startup count clarification: 23 Hermes-specific entries (10 active .vbs, 13 historical/inactive files), plus Wispr Flow in the user Startup directory, plus Tailscale in common Startup: 24 user entries and 1 common entry, 25 total. The earlier progress note incorrectly labeled these as 23 user plus 2 common. Preserve both unrelated entries, especially remote-access Tailscale.
- Full process list: 261 metadata records, 20 matching Hermes/business markers. Includes PID, parent PID, executable, creation time, profile, role, and script paths; no raw command lines. Process state is transient and must be recaptured before any later stop.
- Root-wide filesystem enumeration found 4 historical cron files with 22 definitions, including 16 stored enabled:true flags. These are backup/snapshot copies, not 16 additional active jobs. Preserve their bytes and do not copy them into live runtime paths. The stop plan lists them separately in Tier C.

## Backup verification

Both required Oct 13 artifacts are present on the PC under `C:\Users\nicho\backups\hermes-retirement-20261013`:

| Artifact | Verification |
| --- | --- |
| `accounting-procedures-recovery.zip` | 328,768 bytes; 115 ZIP entries; 565,614 uncompressed bytes; all CRCs pass; SHA-256 `15ee98df7ff21f6fe58de82af26aa8ab9fc9a8cac6045431bdbdc416640eefe1`. |
| `nick-work-kanban.snapshot.db` | 21,733,376 bytes; SHA-256 `62dae3adafebc52dca2f4e5dcb8aa7294b2626b3cffa3cb2f60d27cfaf852a25`; matches original verification record; current read-only immutable `PRAGMA integrity_check` = ok. |

The original snapshot verification was captured at 2026-10-13T21:22:43.766775+00:00. Its 1,927 task rows still match the recorded status counts: 96 archived, 313 blocked, 1,391 done, 1 ready, 5 scheduled, 120 todo, 1 triage. The 440-task handoff refers to the unfinished subset (313+1+5+120+1), not all rows. This old consistent snapshot is verified, but is not a current final retirement backup. No live Kanban or session database content was read.

`Hermes_Brain_Backup`: enabled/Ready, last run October 16 07:20:22 ET, last result **1**, next scheduled run 11:20:21 ET, 4-hour interval. The 07:20 log is `C:\Users\nicho\AppData\Local\hermes\backup-logs\brain-vault\brain-sync-20261016T072023.log` (686 bytes, 6 lines). Its safe diagnostic classification records local export completed, remote export failed because the remote workspace is not reachable, vault update failed, remote snapshot skipped, sync ended with error. The previous three logs also show failure signals. Low-level transport details were not exposed by the safe classifier; no repair or retry was attempted.

The task launches `HermesBrainOps\Sync-HermesBrain.ps1` through a silent .vbs. Its configured remote host is `10.0.1.16`, workspace `/Users/archerclawdington/.openclaw/workspace`, backup root `/Users/archerclawdington/.openclaw/backups/hermes-brain-vault`. Configuration is not proof that the destination still exists or is reachable. No files were found immediately in the configured local `backup-versions\brain-vault` directory. The script explicitly describes excluded runtime assets as requiring a separate consistent binary backup: the brain/vault projection is not a full recoverable Hermes archive.

## Archive capacity and required scope

| Source | Logical GiB | Files |
| --- | ---: | ---: |
| `C:\Users\nicho\AppData\Local\hermes` | 120.4784 | 2,785,454 |
| `C:\Users\nicho\.hermes` | 0.0003 | 8 |
| `C:\Users\nicho\HermesBrainOps` | 0.0016 | 26 |
| `C:\Users\nicho\HermesLegacyData` | 0.1446 | 1,608 |
| `C:\Users\nicho\ObsidianVaults\Hermes Brain` | 0.0513 | 3,978 |
| `C:\Users\nicho\.worktrees` | 0.3100 | 18,872 |

Measured total for these six roots: **120.99 GiB**. C: has **626.00 GiB free**, NTFS, on a 951.83 GiB volume. Measurements exclude 16 reparse points rather than traversing them, with zero enumeration errors. Their paths and targets are recorded in storage.json. Two links point outside the root to `C:\Users\nicho\elkhart-orderops-fix\node_modules`; other links point into Hermes source trees. Reparse metadata and necessary target dependencies must be preserved deliberately; never recursively dereference links blindly.

Destination options (nothing created):

- Local C: archive outside all retirement roots, for example a new dated child of `C:\Users\nicho\backups`. There is ample measured capacity. Budget at least 150 GiB per uncompressed working copy for filesystem overhead and growth; staging + archive + restore-verification copies could require roughly 450 GiB, still below today’s 626 GiB free. Compression savings are unknown. This is same-disk recovery, not disk-failure protection; recheck capacity before any future archive.
- External NTFS or other archive-capable disk: prefer 500 GiB or more available, with enough additional room for independent restore verification; avoid FAT32’s per-file archive limit. D: and E: appear as removable devices without reported media/filesystem/capacity, so neither is an approved usable destination yet.
- NAS/external network target: an explicitly chosen reachable share with sufficient free space, restricted access, and verified restore capability. No SMB mappings are present in this Windows login session; no NAS destination or free capacity has been established. The existing remote brain destination is failing and cannot be assumed usable.

For a recoverable archive, first stop and observe each approved writer; take fresh consistent backups of Kanban and other non-session SQLite stores using their supported backup APIs while idle, or retain database plus WAL/SHM coherently after all writers exit. The existing Oct 13 ledger snapshot alone cannot cover subsequent changes. Inventory and preserve Kanban attachments/logs/workspaces, original IDs and effect/dedupe ledgers, cron definitions, scheduled-task definitions, Startup launchers, canonical vault and legacy knowledge, Hermes source/version and exact runtime dependencies, nested and external worktrees, associated repositories/scripts, and reparse metadata. The inventory already identifies external script/runtime paths; the six-root size is not a guarantee that every external business dependency is included. Never run a business script to verify recovery.

Keep a per-file inventory (relative path, size, timestamps, hash where permitted), access controls, source/version metadata, exclusions, and an archive checksum. Test extraction into an isolated destination with network/schedulers disabled, compare counts and hashes, and verify database integrity and original task/status counts without reading customer bodies. Choose an archive format/tool that supports millions of files and required link/ACL metadata; do not rely on the current vault projection or a generic ZIP command alone.

Secret exclusions and recovery limit: do not print, read, copy, or rotate credentials. Exclude credential stores, private keys, token/auth/session credential files, .env and credential-bearing configuration, browser profiles/cookies, and DPAPI key material from a general archive; identify exclusions by metadata without inspecting secret values. Never read Hermes session databases into chat. Confidential histories and session data require a separately approved opaque preservation method that does not expose their contents or copy credential stores; keep original files intact on the PC meanwhile. Sanitize manifests so secrets never appear in paths/content extracts. Excluding credentials means a sanitized archive alone cannot promise authenticated recovery after loss of this Windows account/device; retain original device/account custody and establish an approved credential recovery/re-authentication plan before claiming full recoverability. No archive has been created in this phase.

## Stop plan and blockers

The proposed stop plan has 107 rows: Tier A 31, Tier B 18, Tier C 58. Tier A includes infrastructure/watchdogs/startup; Tier B includes all named business duties, the live Lippert shadow candidate and functional CS health coverage, All_Order_Review, Direct_Shopify, and completion mirror. Tier C preserves 16 disabled current cron definitions, 5 disabled tasks, 13 inactive Hermes Startup files, 2 unrelated Startup entries, and 22 historical cron definitions.

PC access is working. Remaining gates are Nick’s plan approval, the coordinating chat’s exact item go signals, fresh end-of-life database/archive verification, destination selection and credential recovery scope, and independent evidence for eventual gateway process shutdown. The completion mirror remains untouched despite its consumer-side clearance. No broad stop or uninstall is safe from this inventory alone.

## Validation

Checked JSON parsing, every plan row against its source inventory, 18 live versus 16 historical enabled flags, all 107 plan rows, original/current snapshot checksum and status counts, ZIP CRCs, and explicit credential-shaped literals. Windows PowerShell parsed the proposed cron helper successfully without executing it. Validation was scoped to these isolated inventory/report artifacts; no application build, full test suite, or production restart was performed.

## Files

- [backup-diagnostic.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/backup-diagnostic.json)
- [backup-diagnostic.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/backup-diagnostic.ps1)
- [backup-discovery.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/backup-discovery.json)
- [backup-discovery.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/backup-discovery.ps1)
- [backup-verification.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/backup-verification.json)
- [collect-readonly.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/collect-readonly.ps1)
- [inventory.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/inventory.json)
- [run-readonly.py](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/run-readonly.py)
- [stop-plan.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/stop-plan.md)
- [storage-readonly.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/storage-readonly.ps1)
- [storage.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/storage.json)
- [verify-backups.ps1](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/verify-backups.ps1)
- [SHA256SUMS.txt](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/SHA256SUMS.txt)
- [README.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase1/README.md)
