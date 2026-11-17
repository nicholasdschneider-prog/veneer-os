# Offsite backups and disk housekeeping

Three launchd one-shots keep the internal disk from filling and keep a copy of the data off this
Mac. Templates live in `deploy/launchd/`; `installer/install-darwin.mjs` renders and loads them.

| job | when | script | log (`~/Library/Logs/veneer-pro/`) |
|---|---|---|---|
| `com.veneer.disk-sweep` | nightly 02:40 | `installer/disk-sweep.mjs --apply` | `veneer-disk-sweep.log` |
| `com.veneer.pro.backup` | nightly 03:20 | `installer/backup.mjs` (existing) | `veneer-pro-backup.log` |
| `com.veneer.pro.backup-offsite` | daily 04:30 | `installer/backup-offsite.mjs` | `veneer-pro-backup-offsite.log` |
| `com.veneer.disk-autopilot` | every 10 min | `installer/disk-autopilot.mjs` | `veneer-disk-autopilot.log` |

## What is uploaded, and when

At 04:30 `backup-offsite.mjs` takes the newest finished nightly archive in `VP_BACKUP_DIR`
(`veneer-pro-YYYYMMDDTHHMMSSZ.tar.gz`, ignoring anything modified in the last two minutes) and,
if it has not already been uploaded, streams it through `age` into `rclone rcat`. Nothing
unencrypted leaves the Mac and no temporary copy is written. The object is named
`<archive>.age` in the private R2 bucket `veneer-backups` (`VP_BACKUP_OFFSITE_BUCKET`).

After the upload the script lists the object and requires its size to equal the ciphertext bytes it
sent. Only then does it record the upload in `VP_BACKUP_OFFSITE_STATE` (default
`$VP_BACKUP_DIR/offsite-state.json`, mode 0600): name, object, bytes, SHA-256 of the ciphertext,
time, plus the last 40 attempts. A failure records `lastError`, keeps the previous `lastUploaded`,
and exits 1. The job is separate from the nightly backup, so an offsite failure never affects the
local archives.

Missing configuration is not a crash: the script names the missing keys, records that as
`lastError`, and exits 0.

## Encryption: the Mac cannot decrypt its own offsite copies

Archives are encrypted on the Mac with an age **public** key (`VP_BACKUP_OFFSITE_AGE_RECIPIENT`,
`age1…`). The matching **private** key exists only in Doppler: project `main`, config `prd`, secret
`VENEER_BACKUP_AGE_SECRET_KEY`. It is never stored on this Mac. This is deliberate: someone who
takes over the Mac, or the R2 credentials, still cannot read the offsite copies.

## Retention

After each verified upload the bucket keeps the newest 7 daily objects plus the newest object of
each of the 4 most recent ISO weeks older than those (7 daily + 4 weekly); the rest are deleted
with `rclone deletefile`. Objects whose names do not match `veneer-pro-<stamp>.tar.gz.age` are never
touched.

## Credentials

R2 is reached through rclone's S3 backend, configured only through environment variables on the
child process (no rclone config file, nothing secret in argv or logs):

- `VP_BACKUP_OFFSITE_ACCOUNT_ID` — the Cloudflare account; endpoint `https://<account>.r2.cloudflarestorage.com`.
- `VP_BACKUP_OFFSITE_ACCESS_KEY_ID` — the existing Cloudflare API token's **id**.
- `VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY` — the **SHA-256 hex digest of the token value**.

That derivation is Cloudflare's documented way of using an API token with R2 Storage permissions
as S3 credentials.

## Status

```sh
node installer/backup-offsite.mjs --status
```

prints the last uploaded archive name, time, size and the last error, with no secrets. The disk
autopilot also reads this file and raises `offsite-stale` when no upload has succeeded in 50 hours.

## Restore runbook

Run on any Mac with `rclone`, `age` and the Doppler CLI. Never print the key or the R2 secret.

```sh
work=$(mktemp -d) && chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# 1. The private key, straight from Doppler into a 0600 file.
(umask 077; doppler secrets get VENEER_BACKUP_AGE_SECRET_KEY --project main --config prd --plain > "$work/key")

# 2. The same env-var rclone configuration the upload uses (values read from the env file or Doppler).
export RCLONE_S3_PROVIDER=Cloudflare RCLONE_S3_REGION=auto RCLONE_S3_NO_CHECK_BUCKET=true
export RCLONE_S3_ENDPOINT="https://<account id>.r2.cloudflarestorage.com"
export RCLONE_S3_ACCESS_KEY_ID=...        # token id
export RCLONE_S3_SECRET_ACCESS_KEY=...    # SHA-256 of the token value

# 3. Pick an object and download it.
rclone lsl :s3:veneer-backups
rclone copyto :s3:veneer-backups/veneer-pro-YYYYMMDDTHHMMSSZ.tar.gz.age "$work/backup.tar.gz.age"

# 4. Decrypt and list.
age -d -i "$work/key" -o "$work/backup.tar.gz" "$work/backup.tar.gz.age"
tar -tzf "$work/backup.tar.gz" | head
```

Copy `$work/backup.tar.gz` somewhere durable before the `trap` removes the work directory, then
continue with the normal restore steps in [README.md → Backups](../README.md#backups): stop the
application services in an approved window, move the current `DATA_DIR` aside (never delete it),
extract the archive's `data/` into `DATA_DIR`, and start the services again. Note that
`installer/restore-backup.sh` still carries the Linux `systemctl` flow; on this Mac do the steps by
hand.

## Cost

At full retention the bucket holds 11 archives of about 16 GB each, roughly 180 GB. R2 standard storage is billed per GB-month (about $0.015 at the time of writing, first 10 GB free), so expect about $2.50 to $3 a month, growing with the archive size. Uploads and downloads carry no egress charge; the request counts are far inside the free allowance. Check the Cloudflare billing page for the real figure.

Uploads are throttled to 2 MiB/s between 06:00 and 23:00 (`VP_BACKUP_OFFSITE_BWLIMIT`) so a daytime run cannot saturate the uplink the public tunnel shares; the scheduled 04:30 run is unthrottled.

## Disk sweep

`installer/disk-sweep.mjs` moves stale work folders off the internal disk and leaves a symlink at the
old path. Configuration: `VP_DISK_SWEEP_CONFIG` (default `~/.config/veneer-pro/disk-sweep.json` in
the login home):

```json
{ "roots": [{ "source": "/Users/<you>/Projects/ERVP/out", "target": "/Volumes/VeneerData/Veneer/ervp-out" }],
  "minBytes": 5242880, "ageHours": 48, "skipNames": ["state"] }
```

A top-level folder moves when it is at least `minBytes` and nothing inside changed for `ageHours`;
an active one is searched one level down (skipping `skipNames`). Without `--apply` it only prints.
With `--apply` it refuses everything unless each target volume is mounted and is not the boot disk,
skips folders with open files (`lsof +D`) or an existing target, copies with `rsync -a`, verifies
file count and bytes, then swaps in the symlink. Moves are logged to `sweep-log.jsonl` next to the
first target (`VP_DISK_SWEEP_LOG` overrides).

## Disk autopilot

`installer/disk-autopilot.mjs` measures free space on `/System/Volumes/Data`, swap size, whether
the external backup drive is mounted, the newest nightly backup and the offsite state, and raises:

| condition | when |
|---|---|
| `disk-low` | under 25 GiB free |
| `swap-high` | 10 GiB of swap or more on three samples in a row |
| `external-unmounted` | the backup directory does not resolve to another volume |
| `backup-stale` | newest nightly backup older than 26 h, or none |
| `offsite-stale` | offsite configured and no verified upload in 50 h |

On `disk-low` with the drive mounted it runs the sweep itself, at most once an hour, and measures
again. Anything still wrong wakes the chat in `VP_DISK_AUTOPILOT_CHAT` with one wake row per run,
at most once per condition per UTC day. State lives in `$DATA_DIR/run/disk-autopilot.json`.
`--check-only` measures and prints without sweeping or writing anything.
