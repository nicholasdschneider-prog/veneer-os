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

Keep the SSD connected during operation. Startup unlock is tested, but an
unexpected cable removal while services are running can still interrupt work.
A separate backup of both data and the encryption recovery key is necessary:
the local key enables unattended unlock, and the SSD is storage, not a backup.
Never log or commit the recovery key.

Migration manifests, original plists, deployed-file hashes and the database
snapshot are in the operator's task folder `ssd-setup-20261015`. Restore data
before removing links or disabling guards. Never start against empty replacements.
