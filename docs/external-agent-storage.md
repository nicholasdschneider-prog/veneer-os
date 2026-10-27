# External agent storage on this host

The October 15, 2026 maintenance move places bulk histories on the encrypted
VeneerData APFS SSD. SQLite databases, credentials, application code, and browser
profiles remain internal. Existing logical paths remain valid through symlinks:

- `~/veneer-pro-home/.codex/sessions` → `/Volumes/VeneerData/Veneer/agent-data/codex-sessions`
- `~/veneer-pro-home/.claude/projects` → `/Volumes/VeneerData/Veneer/agent-data/claude-projects`
- `~/.local/share/veneer-pro/transcripts` → `/Volumes/VeneerData/Veneer/agent-data/veneer-transcripts`

The retired OpenClaw records directory also links into the SSD's `Veneer/archives`
folder. This is an archive, not a running OpenClaw installation.

## Startup and maintenance

Six installed launch agents (the four core services, web watchdog, and backup)
run `~/.local/lib/veneer-volume/ensure-mounted.py --exec` before their original
command. Its versioned source is `scripts/ensure-external-volume.py`.
`~/.config/veneer-pro/external-volume/volume.json` identifies the volume by UUID,
not just its name. The helper unlocks it using a private local recovery-key file,
checks encryption, filesystem ownership and writability, and refuses startup
when absent or wrong. It never creates a substitute data directory.

The installer preserves this explicit host guard when updating job arguments;
release inspection recognizes the wrapped original command. Do not manually
replace these plists with unguarded templates. A fresh install on another host
requires an explicit storage configuration; this host's key is not in Git.

For an approved storage maintenance window, `scripts/restart.mjs --stop` and
`--start` operate installed supervisors without snapshotting or activating a new
application build. Both require `--maintenance-approved`; interrupting active
turns additionally requires the human-authorized `--allow-active-turns` flag.
Stop the watchdog before core services and restore it after core health checks.
No automatic replay of uncertain business actions should be performed.

Keep the SSD connected during operation. Manual unlock was tested, but the
October 15 reboot exposed a launchd privacy/sandbox unlock failure (-69464).
Unattended startup remains unverified until that is resolved and a controlled
reboot passes. Unexpected cable removal can also interrupt work.
A separate backup of both data and the encryption recovery key is necessary:
the local key enables unattended unlock, and the SSD is storage, not a backup.
Never log or commit the recovery key.

Migration manifests, original plists, deployed-file hashes and the database
snapshot are in the operator's task folder `ssd-setup-20261015`. Restore data
before removing links or disabling guards. Never start against empty replacements.

## Backup coverage after relocation

The nightly backup explicitly copies the target of the top-level transcript
link, preserving the previous transcript coverage. Other and nested symlinks
remain links. Temporary staging is on the SSD in a private directory configured
in volume.json (`backup_staging_dir`). Since October 27, the original archive
directory `~/veneer-pro-home/.local/share/veneer-pro-backups` links to
`/Volumes/VeneerData/Veneer/backups`, retaining the seven newest archives.
The storage guard exports `VP_BACKUP_STAGING_DIR` so installer
refreshes retain this behavior. The host disk-pressure preflight counts relocated
transcript bytes and reserves space on both filesystems. Service-native Codex and
Claude homes were not part of this nightly DATA_DIR backup; a separate backup of
those histories and retired archives is still needed for protection against SSD
failure. The migration itself is not a second copy of that data.

`VP_BACKUP_RECOVERY_DIR` configures one rolling internal recovery archive at
`~/veneer-pro-home/.local/share/veneer-pro-backup-recovery`. The backup job copies
the completed archive to a private temporary file, compares SHA-256 checksums,
flushes and publishes it, then removes older recovery archives. A failed copy
preserves the previous recovery archive and fails the job before primary pruning.
The installed ERVP disk guard budgets the SSD staging/archive and the internal
replacement separately. Its versioned source and tests are in
`scripts/disk-pressure`; the installed copy remains in
`~/Projects/ERVP/tools/disk-pressure` to preserve telemetry paths. The UUID mount guard still runs before the nightly job;
do not replace the archive symlink with an ordinary directory if the SSD is absent.

Seven external archives plus one internal recovery copy protect the covered
database/transcripts from loss of either data disk; they do not provide off-site
protection or extend coverage to provider-native homes and retired archives.
No Time Machine destination or off-machine replication was established during
this migration. The audit is in the operator task's
`backup-migration-20261027-134024` folder. Original filenames/timestamps were
preserved, and all seven transferred archives passed SHA-256 verification.
