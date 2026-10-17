# Hermes PC recovery baseline — verified October 17, 2026

The sanitized six-root recovery baseline on the PC is **verified after reconciliation**. Independent read-back completed at **00:41:26 ET October 17**. All original errors are resolved. This is a recoverable baseline within the documented exclusions; it is **not a final quiescent seal** while held writers remain live. Phase 2 retirement dispositions and every HOLD/Tier C item remain unchanged.

PC archive: `C:\Users\nicho\backups\hermes-final-20261016`.

| Verification | Result |
| --- | --- |
| Manifested files / payload | **2,757,421 / 128,730,613,278 bytes** |
| File headers inspected, regardless of extension | **2,757,421 / 2,757,421** |
| SQLite copies passing integrity_check | **468 / 468**, including **269 with nonstandard extensions** |
| Original known SQLite snapshots covered | **199 / 199** |
| Independent restore/sample comparisons | **8 / 8** hash and byte matches, spanning all six roots plus a long-path file and the recovered lock |
| Original manifest and addendum checksums | Match independent read-back |
| ACL export metadata | Present; original and lock ACL hashes independently match |
| Unresolved original errors / final verification errors | **0 / 0** |

The original archive controller finished October 16 at 17:54:29 ET. The reconciliation process finished October 17 at 00:32:28 ET and is absent. Its source hash matches the retained operator artifact. Neither process was relaunched. No Hermes/business job, deletion, application source edit, build, restart or held-job stop was performed.

## Reconciliation and evidence

The original 3,219 FileNotFoundError entries were Windows path-length access failures. Exact-path inspection found all archive files readable using extended-length paths; all 3,219 newly calculated hashes matched their source files. The one Robocopy failure was the 37-byte dashboard supervisor.lock. After the approved dashboard stop/observation and original controller completion, its separately preserved PC custody copy was placed into the previously missing archive path with the expected SHA-256. No existing payload was overwritten.

The original manifest and original needs_review report remain preserved. The authoritative reconciled result is under `reconcile-20261016\verification.json`, with independent metadata at `reconcile-20261016\operator-readback.json`. Keep **both manifests** for recovery:

| PC artifact | Records | SHA-256 |
| --- | ---: | --- |
| manifest.jsonl | 2,754,201 | `73890273bc519830796e3cb45fc05dfe7f994d8a76fcd7484808406dcbff57c8` |
| reconcile-20261016/manifest-addendum.jsonl | 3,220 | `49d5b253589a4f5eb506ceb9c38d05c0fe1f30636dc0332e5fd15f6257c1537b` |

The addendum covers the 3,219 previously unhashable paths and the recovered lock. The complete header audit found the additional SQLite copies without relying on file extensions; every detected SQLite copy passed read-only immutable integrity_check. Independent read-back checked manifest record counts/totals/hashes, all 468 database metadata records and known-database coverage, eight actual restored sample hashes/sizes, and ACL artifact hashes.

Metadata-only evidence: [archive-final-readback.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-final-readback.json), [archive-reconcile-status-20261017-0040.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-reconcile-status-20261017-0040.json), [archive-exact-error-audit.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/archive-exact-error-audit.json), [supervisor-lock-custody.json](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/supervisor-lock-custody.json). No archive payload or full manifest was transferred to this Mac.

## Recovery scope and custody

The six roots under `C:\Users\nicho` are AppData\Local\hermes, .hermes, HermesBrainOps, HermesLegacyData, ObsidianVaults\Hermes Brain, and .worktrees. Their PC mirror labels are local-hermes, dot-hermes, brain-ops, legacy-data, obsidian-brain and worktrees. Source/mirror mapping, credential/configuration exclusions and reparse metadata remain in scope.json, exclusions.jsonl and reparse.jsonl on the PC.

Recover into a separate destination using Windows extended-length path support, combine the original manifest and addendum, and compare restored file hashes/sizes against those records. Retain source originals, the PC/account and custody files. Credentials, configuration and browser secrets were excluded by metadata; reauthentication and original configuration/account custody are required. External reparse targets were inventoried rather than traversed. This verification covers the declared sanitized six-root payload, not authenticated service startup or external dependencies.

Held writers remained live throughout capture; the six roots do not represent one globally quiescent transaction. Refresh and seal after the owner-approved final cutover. **Brain Backup, vault drift, all held business jobs/gateways, Lippert and the default/root dependency remain retained.** This report grants no further stop, uninstall or deletion authority.

The requested archive verification is complete. No further archive observation is pending for this baseline; final-cutover sealing belongs to the existing coordinator’s held work. Phase 2 result: [final-report.md](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2/final-report.md).
