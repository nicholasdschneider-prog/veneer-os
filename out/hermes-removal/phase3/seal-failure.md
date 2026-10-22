# Quiescent seal not verified — deletion stopped

The PC refresh controller exited at20:22:56ET onOctober21 with SQLite OperationalError. PID9904 is absent; its source SHA is unchanged. No controller was relaunched and no source or archive payload was changed by the diagnostic probes. All six source roots remain intact; Phase3 deletion has not begun.

Bounded read-only diagnostics localized SQLITE_CANTOPEN(code14) to a265-character snapshot path under accounting-migration/evidence/chargebacks-2026-07-16/100117908/chrome-capture-profile/GPUPersistentCache/DawnGraphiteCache/.../cache.db. Both normal and extended readonly SQLite URIs fail. The existing152-character Windows8.3short-path URI successfully passes integrity_check. This demonstrates a path-access issue for that snapshot; it does not verify the full archive or all remaining databases.

The committed operator index contains1,120,000 files and47SQLite entries. The inventory stream extends beyond that commit boundary and66snapshot files exist, so a retry cannot blindly resume from the committed count or overwrite partial files. Preserve this attempt, its original baseline records and previous-payload custody. A repair can use source-verified Windows short-path access in an isolated operator artifact, after reconciling already-captured inventory/snapshots and defining a new resumable launch journal. No business source change or Hermes job is necessary. No repair/controller relaunch was performed in this checkpoint.

The hard gate remains closed: six-root refresh, complete manifest/addendum, every SQLite check, restore samples, ACL checks, final quiescence readback and lateLTLconfirmation must all pass before any deletion. The original deletion approval requires no further confirmation once those checks actually pass, but it authorizes no deletion now.

[Machine-readable verdict](/Users/archerclawdington/veneer-os/out/hermes-removal/phase3/seal-verdict.json). [Read-only path probe](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/archive-longpath-readonly-probe.json). [Failure and receipt index](/Users/archerclawdington/veneer-os/out/hermes-removal/phase2b/README.md).

## Authorized repair also stopped — October22 00:08ET

The preserved first attempt was reconciled and the approved repaired controller launched once. PID14696 is now absent with unchanged source hash. It stopped on Prior baseline payload hash mismatch at the reserved-name path profiles/ervp-orders/workspace/NUL. Extended-length reads of source, mirror and newly preserved history agree (54bytes, SHA63a1626b4d619d0a6614f871440e7f72c64347101e40e7ea87082676d5b0ec22); the historical baseline manifest records the empty-file SHA. Normal-path metadata reports0bytes. This is evidence of reserved-name access ambiguity and historical divergence, not proof of when or why the difference arose.

The finite read-only audit found2,380,000 committed source rows,371version records and295 new prior-history files. One copied history file was not journaled before the hash check halted; it remains preserved. No payload was repaired, no controller was relaunched and no file was deleted. Both attempts and all six source roots remain. Brain and late LTL confirmations passed, but the refresh, manifests, complete integrity/restore/ACL and independent seal checks remain incomplete. The gate is NOT_VERIFIED. Under the explicit instruction to stop on another failed check, no automatic retry is armed.

See [failure audit](../phase2b/archive-resume-failure-audit-final.json) and [current verdict](./seal-verdict.json).
