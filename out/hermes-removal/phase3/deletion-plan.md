# Approved Hermes removal plan after verified seal

Sealed archive: C:\Users\nicho\backups\hermes-final-20261016

Authoritative current manifest SHA-256: `e315a27507da08bf5d3de7dc50cda93f919aa91fd151a72ea74c7c8a459ff3c1`.

Recovery custody: PC archive/phase3-custody-20261022; plan SHA-256 `af23f0db6e18bbc240aafe4f3fd474d43f1e56cbe133f4afc546c12a375c28b7`.25 exact task XMLs and23 Startup originals are copied and hashed.31 wrappers match archived copies.

| Order | Path/group | Bytes before |
| --- | --- | ---: |
| 1 | 25 Hermes tasks,23 Startup launchers,31 wrappers | Recorded individually in custody plan |
| 2 | C:\Users\nicho\.worktrees | 332,816,845 |
| 3 | C:\Users\nicho\HermesLegacyData | 155,312,482 |
| 4 | C:\Users\nicho\.hermes | 309,667 |
| 5 | C:\Users\nicho\HermesBrainOps | 1,747,995 |
| 6 | C:\Users\nicho\AppData\Local\hermes | 129,418,156,292 |
| 7 | C:\Users\nicho\ObsidianVaults\Hermes Brain | 55,135,400 |

Total source bytes:129,963,478,681 (reparse targets excluded). Remove reparse entries without recursion first; skip a root if any entry cannot be safely removed. Keep external elkhart-orderops-fix targets intact. Record locked paths and continue; no reboot.

KEEP backups/, ervp-vendor-automation, orderops-src, shared Python/uv, Tailscale, OpenSSH, unrelated Startup entries and the independent ERVP_Dometic_Inventory task. No action outside explicit Hermes scope.

Original per-file hashes, recovery paths, worktree ownership and reparse metadata: [reviewed plan](./deletion-plan-reviewed.json). No deletion has started at plan recording.
