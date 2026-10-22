# Hermes Phase 3 — seal verified, removal authorized

Nick’s explicit October 21 instruction in chat fce19860, “Delete it too,” was relayed by the coordinator in this thread. Source deletion is approved in advance; no further confirmation is required after the gate passes. The quiescent seal is now VERIFIED and recorded in seal-verdict.json and onPC. All required checks passed. Removal is authorized under the exact plan; no deletion had started at seal recording.

## Mandatory gate

Before any deletion, independently verify and record a sealed verdict here: zero Hermes processes, enabled cron jobs, enabled scheduled tasks and active Startup launchers; completed incremental refresh of all six archived roots; a new manifest addendum and its SHA-256; successful integrity_check of every SQLite copy, including nonstandard extensions; and a successful restore sample from the archive. Archive payload and full manifests stay on the PC at C:\Users\nicho\backups\hermes-final-20261016. The earlier verified baseline was not quiescent and cannot satisfy this gate. If any required check fails, stop and report; do not delete.

## Approved deletion order after verified seal

1. Remove Hermes scheduled tasks, Startup launchers and .vbs/.cmd wrappers under hermes/services and profiles/*/scripts. Record original hashes, archive recovery provenance and each removal.
2. Remove C:\Users\nicho\.worktrees (Hermes worktrees), HermesLegacyData, .hermes and HermesBrainOps, in that order. Verify exact paths and ownership before removal.
3. Remove C:\Users\nicho\AppData\Local\hermes.
4. Remove C:\Users\nicho\ObsidianVaults\Hermes Brain only if its archive copy is verified. Otherwise preserve it and report why.

Record bytes before/after every step and free disk space before/after the full deletion. Use PowerShell Remove-Item with the Windows extended-length path prefix. Record locked paths and continue to other approved paths; never reboot. Reconcile uncertain effects from the source journal before retrying. Do not delete a path merely because its name contains Hermes.

## Preserve

Keep C:\Users\nicho\backups\, including the sealed archive, hermes-phase2-20261016 and hermes-retirement-20261013. The incomplete-0847 directory may be removed under the user’s permission, but no removal is necessary for this plan. Keep ervp-vendor-automation, orderops-src, Tailscale, OpenSSH and everything outside the explicit Hermes scope. Keep shared Python/uv runtimes; Hermes-private virtual environments inside removed roots may go with those roots. No job execution, application source modification, build, production restart or PC reboot is authorized.

Report Phase 2b after step 5 and again after verified step 6 under request_key hermes-pc-operator-phase2b. Report the exact deletion plan and final Phase 3 outcome to coordinator fce19860 under request_key hermes-pc-operator-phase3, with sealed archive path, authoritative manifest SHA-256, space recovered, every removal and any leftovers. No deletion has been executed by this plan.

## Repair checkpoint

The accepted NOT_VERIFIED verdict remains in force. The coordinator authorized an isolated path-access repair and reconciled resume, launched once at00:51:44Z Oct22 after all captured snapshots, prior versions and inventory-tail records reconciled. See the Phase2b repair receipts. This is not a sealed verdict; no deletion has started. A complete refreshed archive, independent readback and late LTL confirmation must pass before the gate changes.

The repaired refresh also failed at04:08:18Z October22 on a reserved-name NUL baseline-hash mismatch. Both attempts and all source roots are retained. See seal-failure.md and seal-verdict.json: NOT_VERIFIED, deletion_permitted=false. No automatic retry is armed.

The coordinator subsequently authorized scoped reserved-name corrections and one more refresh. Reconciliation and preflight passed; R3 refresh launched once at04:54:05Z October22. The failed verdict remains the deletion gate until a complete independently verified seal replaces it. See Phase2b current records.

## Current completion checkpoint

R3 completed successfully13:36:50Z October22. Independent archive review and freshzeroquiescence/31ledgers0 passed. Removal recovery preparation is running separately (PID21104, prepare-launch.json); the current gate remains NOT_VERIFIED until that preparation is reviewed and the sealed verdict is recorded. Deletion has NOT started. Preserve ERVP_Dometic_Inventory: its action is outside Hermes. See independent-review.json and inventory-pre-seal.json. delete-sealed.py is a reviewed local draft only.

## Current sealed verdict

VERIFIED_QUIESCENT_SEAL: all incomplete_checks passed; PC seal file hash matches local receipt. See seal-verdict.json, record-seal.json and deletion-plan.md. Next action: the advance-approved removal in the recorded order, with per-effect journals, hashes, sizes and KEEP protection. No further approval is required.

## Removal in progress

Advance-approved removal launched ONCE14:11:28Z, PID19668/parent17912/created2026-10-22T10:11:28.7076610-04:00, PC remove-phase3.py SHA57B37931C72003E56CF07A3D4340C71D1F3F0047AB3F007A86F1E870B83E09BB. Hard verified seal and both manifest/plan SHA gates passed inside the controller before any effect. PCjournalphase3-delete-20261022. Do not replay or edit the running controller.

Journal confirms25Hermes task registrations,23Startup launchers,31wrappers and four roots removed: .worktrees,HermesLegacyData,.hermes,HermesBrainOps. All recorded after-sizes0/errors[]; no retained entries at this checkpoint. MainAppData/Local/hermes root and verifiedObsidianVaults/Hermes Brain remain pending in the same controller. Root measurement can precede the next status update; source journal is authoritative. Keep archive/recoverycopies, repos, Tailscale/SSH/sharedruntimes, independentERVP_Dometic_Inventory and non-Hermes items untouched. Final free-space/KEEP/quiescence/leftovers checks pending.
