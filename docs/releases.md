# Release snapshots: what a crash respawns

## Why

launchd's `KeepAlive` respawns each node service from the path in its plist. Before release
snapshots, that path was the checkout's `server/dist`, which `npm run build` rewrites in place.
So any crash after a build silently deployed the new build, and the bytes that had been running
were gone. On 2026-10-13 web crashed (undici `setTypeOfService` EINVAL) and respawned onto a
rebuilt dist. That respawn applied migrations 0178/0179 without an approved restart, and the prior
executable could not be recovered for rollback (BUILD806 gate 1).

## How it works

- `DATA_DIR/releases/<id>/` is a read-only copy of a build:
  - `server/dist`, `web/dist`, both `package.json` files, `provider-runtimes.json` and
    `installer/provider-runtimes.mjs`.
  - `release.json` and `MANIFEST.sha256`.
  - The id is `<git sha 12>[-dirty]-<manifest sha 12>`.
  - On APFS the copy is a clone, so `web/dist` costs almost no space.
- `DATA_DIR/releases/active/<service>` is a symlink to the release that service launches. The web,
  runner, app-runner and term plists run `active/<service>/server/dist/...`. The web watchdog
  follows `active/veneer-pro`.
- `DATA_DIR/releases/previous/<service>` is the release that pointer replaced: a verified prior
  artifact for rollback.
- `DATA_DIR/releases/activations.jsonl` records every pointer move.
- Node runs the real path behind the symlink. A running process never changes bytes; a respawn
  loads whatever the pointer names.

## Who moves a pointer

Only an approved deployment:
- **`npm run restart -- --maintenance-approved <services>`**:
  1. Snapshots the current build. A snapshot by itself activates nothing.
  2. For each requested release-mode service, moves that service's pointer immediately before
     signalling it, after its own safety recheck.
  3. After `/healthz` is green, confirms that web and runner report the activated release id.
  4. Prints the rollback command for every service that moved.
- **`--release=<id>`** activates a named release instead of a new snapshot, for example the
  recorded previous release to roll back.
- **`node installer/install-darwin.mjs --activate-release --release-services-only --maintenance-approved`**
  is the first-activation path. It snapshots the build, points all four services at it, and
  reloads only the release jobs (web, runner, app-runner, term, web-watchdog) whose plist or
  pointer changes. Chrome, the browser manager, cloudflared, backup, Supermemory and the boot
  probe stay loaded and untouched, and nothing is provisioned. Without `--maintenance-approved`
  it refuses with exit 2, except under `--dry-run`, which writes nothing.

## Installer guard

Every installer run that reloads jobs on an installed machine prints its plan first: the exact
jobs to reload and why, the jobs it leaves alone even though their rendered plists differ, the
pending-turn count, and the Veneer Browser occupancy. `--dry-run` stops there.

The run then refuses, loudly and with a non-zero exit, before any snapshot, pointer move,
env/provisioning write or plist write, if any of these holds:

- `--maintenance-approved` is missing;
- `pending_turns` has pending rows (the same `scripts/restart-safety.mjs` check as `restart.mjs`);
- any Veneer Browser working copy is running, or the manager's state cannot be read:
  - running means occupied, held with `keep_open`, or not yet paused;
  - occupancy comes from the manager's authenticated, read-only, loopback `GET /v1/capacity`,
    which excludes warm pool copies.

The write phase runs in a fixed order:

1. The final check.
2. Write the planned plists.
3. Move the release pointers.
4. A pre-reload check.
5. Bootstrap the one-shot reload helper.

A crash respawn before step 3 still loads the old bytes. If step 4 refuses, or the helper
cannot be bootstrapped, the plists and the active/previous pointers are restored exactly. A
service that had no release loses its link again and falls back to the checkout. No job is
reloaded. Nothing is retried, delayed or forced.

`--allow-active-turns` skips only the pending-turn check, and only when given explicitly, for a
human-authorized interruption. Browser occupancy is never skipped. Once the helper is
bootstrapped, its result is the deployment outcome. Failures are reported from its status file,
not rolled back automatically. Read state before doing anything else.

`node scripts/releases.mjs snapshot | status | list | verify <id>` never activates anything.

## What it does not change

- **Crashes:** a crashing service still exits non-zero, logs, and launchd respawns it.
  - Only WHICH bytes respawn changes.
  - Nothing refuses to start silently. If a release fails verification, the installer renders the
    checkout path for that service and prints a WARNING, rather than pointing launchd at bytes that
    no longer match their record.
  - Every service logs `[release] <service> running release <id>` at boot, or a warning that it
    runs the checkout build in place.
- **Dependencies:** `node_modules` is linked to the checkout, not copied. `release.json` records the
  `package-lock.json` hash so a dependency change after activation is visible. A dependency change
  still needs an approved window.
- **Browser manager and boot probe:** both run plain source from the checkout
  (`browser-manager/manager.mjs`, `scripts/boot-probe.mjs`). They are not part of a build and are
  not snapshotted.
- **`scripts/boot-smoke.mjs`:** still smoke-boots the checkout's `server/dist` in a temporary data
  directory.

## The reload helper re-checks before every job

The installer hands the reload to a one-shot launchd helper (`installer/launchd-reload.mjs`), so
the helper survives the runner reload. It re-applies the same gate (pending turns via
`scripts/restart-safety.mjs`, plus Veneer Browser occupancy):

- once over the whole plan when it starts;
- again immediately before each job's bootout.

Jobs reload in this order: web, web watchdog (it follows web's pointer), app-runner, term, runner.

On a refusal the helper stops:
- Jobs already reloaded stay as they are; they run the new release.
- The refused job and every job after it are not booted out. Their plist files and their own
  release pointers go back to their pre-install bytes, modes and targets, so none of them can
  later respawn or reboot onto a release it is not running.
- `status.json` records each job as `reloaded`, `failed`, `refused` or `not_started`, with
  `restored`. The installer exits non-zero.
- Nothing is retried or forced, and the helper never adds `--allow-active-turns`.

A mid-sequence refusal is a partial deployment. Treat it as UNKNOWN: read the per-job status,
then decide.

A durable admission hold (web and runner refusing new turns until the helper finishes) was
considered and not built. The hold would have to be honored by the running web and runner, but
the code they run now cannot honor a flag that does not exist yet. It could only protect a later
deployment, never the one that installs it.

## Exact restore

The write phase captures everything it may change before the first write:
- plist bytes and modes, with absent files recorded as absent;
- every active/previous pointer target, absent ones included.

A throw at any point restores from that capture: any plist write or chmod (first, middle or
last), any pointer move, the activation log write, the pre-reload check, or the helper bootstrap.
`activateRelease` itself also restores every pointer it moved on any throw, which covers
`restart.mjs` as well. If a restore step fails, the error says `RESTORE INCOMPLETE`: read state
before doing anything else.

## Reaching zero pending turns: the armed activation job

A guarded command run from a Veneer turn always refuses, because that turn is a pending row and
nothing excludes it. The executor therefore arms a one-shot launchd job and then ends its turn:

```sh
node installer/activation-job.mjs arm --maintenance-approved \
  --approval-ref "<where the human approval is recorded>" \
  --release <existing release id> --source-sha <sha it was built from> \
  --jobs com.veneer.pro,com.veneer.web-watchdog,com.veneer.pro.app-runner,com.veneer.pro.term,com.veneer.pro.runner \
  --deadline <approved window end, ISO, at most 12 h ahead> \
  --backup-receipt <backup.db.receipt.json> [--consecutive 5] [--interval-ms 2000]
```

**Arming** refuses in any of these cases:
- `--maintenance-approved` or the reference is missing;
- the release was not built from a clean `--source-sha`;
- the shipped source differs from that SHA;
- the checkout dist is not the release's build;
- another activation is armed or running.

Re-arming the identical request is a no-op. The release must already exist; create it first with
`node scripts/releases.mjs snapshot`, which is inert.

**The job:**
1. Waits for `pending_turns == 0` and no running browser copy, `--consecutive` times in a row.
   This includes after the arming turn ends.
2. Refuses without acting if the shipped source (a content fingerprint, not HEAD), the checkout
   dist or the release changed since arming.
3. At the deadline, exits without acting.
4. Otherwise records `running`, which is the point after which nothing is retried, and runs
   `install-darwin.mjs --activate-release --release-services-only --maintenance-approved --release <id> --expect-jobs <jobs>`.
   That command repeats every installer check, and its helper re-checks before each job.

`node installer/activation-job.mjs status` shows the exact state: `armed`, `running`,
`completed`, `failed`, `refused_deadline`, `refused_changed`, `disarmed` or `arm_failed`.
`disarm` works only while it is still waiting. Logs are in
`~/Library/Logs/veneer-pro/veneer-activation.log`.

**Commit-time revalidation.** Every check is repeated under the arm-file lock immediately before
`running` is written:
- the arm id;
- `state == armed`;
- `now < deadline`;
- every binding field (release, dist, source content);
- the backup receipt.

`running` is then written by compare-and-set on (arm id, state). A disarm, re-arm, deadline,
binding change or stale backup that lands during the last read therefore always wins. Terminal
states are compare-and-set too, so a concurrent disarm is never overwritten. A lock held by a live
process makes the other writer fail loudly, never wait.

**The approved window bounds every bootout.** The arm's deadline is passed to the installer
(`--deadline`, required with `--activate-release`). The installer checks it at every guard and
writes it into the helper manifest. The helper checks `now < deadline` before each bootout,
alongside the idle gate. On expiry it stops, exactly like an idle refusal: per-job status, the
not-started jobs restored, exit non-zero.

**One window rule.** `installer/window.mjs` `assertWithinWindow(deadline, now, phase)` is called
with a fresh clock read at these points:
- after every awaited or expensive check: the backup hash, the pending-turn and browser checks,
  and the binding verification;
- immediately before every irreversible step: the plist write, the pointer move, the
  reload-helper bootstrap, each bootout, and the CAS write of `running`.

An expiry refuses with `refused_deadline`: plists and pointers are restored, jobs not started are
restored, the per-job `code` is recorded, and the exit is non-zero. Backup age is computed from a
clock read taken after the hash completes.

**Fresh backup at activation.** The operator takes the online backup (REPORT section 5 method) and
then records a verified receipt:

```sh
node installer/backup-receipt.mjs <backup.db>   # immutable read-only integrity_check + FK check + sha256
```

The arm binds that receipt. The job, immediately before committing `running`, and the installer,
before any write, refuse with `refused_stale_backup` when:
- the receipt is missing, or changed since it was bound;
- the backup did not verify;
- the file's size or sha256 differs;
- the backup started more than 15 minutes ago (`taken_at` is the file's birth time).

Nothing is backed up, retried or recovered automatically. The operator takes a fresh backup and
re-arms.

This was chosen over capping the deadline at `taken_at + 15 min`. The wait only starts counting
quiet reads after the arming turn ends, so a 15-minute window would often expire before any
attempt. Checking the age at the commit enforces exactly the property required: the backup is at
most 15 minutes old when activation starts.

**Non-turn alternative:** a human runs the guarded install command from a shell that is not a
Veneer turn, such as macOS Terminal or SSH. The Veneer web terminal is served by `term`, which is
in the reload set, so do not use it.

## Continuing after a partial first activation

If the helper stops partway through a first activation (idle refusal or window end), the jobs it
reached run the release. The rest are restored to checkout mode: checkout plists, no pointer.
`restart.mjs` cannot complete them. It moves pointers only for services whose plist already
launches a release, and it warns about checkout-mode services.

The continuation is the same guarded installer, on the **same** release id, bounded to exactly
the remaining jobs. It needs the original approval's explicit coverage of a continuation, or its
own bounded approval. Run it through the armed executor so the executor's turn is not pending:

```sh
node installer/activation-job.mjs arm --maintenance-approved --approval-ref "<approval covering the continuation>" \
  --release <same id> --source-sha <same sha> --jobs <exactly the remaining jobs> \
  --deadline <window end> --backup-receipt <fresh receipt>
```

The armed job runs `install-darwin.mjs --activate-release --release-services-only --release <id>
--source-sha <sha> --expect-manifest <manifest> --expect-jobs <jobs> --deadline <end>
--backup-receipt <receipt>`. The installer computes the remainder itself: release jobs whose
plist differs or whose pointer would move. It refuses unless that set equals `--expect-jobs`.

| Stopped before | Continuation reloads |
|---|---|
| app-runner | app-runner, term, runner |
| runner | runner |
| web watchdog | web watchdog, app-runner, term, runner (web's pointer stays) |

The same gates apply as for the first run:
- the whole-plan check and the per-job idle and window gates;
- the fresh backup;
- the exact restore;
- no override.

**Readback after a partial run or its continuation:**
- `releases.mjs status` (pointer targets);
- `shasum -a 256 ~/Library/LaunchAgents/com.veneer.{pro,web-watchdog,pro.app-runner,pro.term,pro.runner}.plist`;
- `.launchd-install/status.json` (per job);
- `launchctl print` and the pids per job;
- web and runner `/healthz` `release`;
- the `[release]` boot line of each service.

## Migration from checkout mode

Until a release is activated, every plist keeps launching the checkout build. The installer, its
`--dry-run`, `npm run restart -- --check` and `releases.mjs status` all print a WARNING for each
service in that mode. The first activation is a deployment and happens only in an approved
window:

1. Build and validate the exact source to deploy.
2. `node scripts/releases.mjs snapshot`, then arm the activation job (above) from the executor's
   turn and end that turn, or have a human run the guarded install command from a non-Veneer
   shell. Run `install-darwin.mjs --activate-release --release-services-only --dry-run` first to
   see the exact job list.
3. Check `node scripts/releases.mjs status`: every service shows `release` mode.
4. Check `/healthz`: web and runner report the release id.

Later deployments use `npm run restart -- --maintenance-approved <services>`.

Keep old releases; nothing prunes them. Remove one only after checking that it is neither an
active nor a previous pointer target. Release directories are read-only, so run `chmod -R u+w`
before removing one.
