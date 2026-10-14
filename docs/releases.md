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
- **`node installer/install-darwin.mjs --activate-release --maintenance-approved`** is the
  first-activation path. It snapshots the build, points all four services at it, and renders
  release-mode plists; its job reload starts the services on the release. Without
  `--maintenance-approved` it refuses with exit 2.

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

## Migration from checkout mode

Until a release is activated, every plist keeps launching the checkout build. The installer, its
`--dry-run`, `npm run restart -- --check` and `releases.mjs status` all print a WARNING for each
service in that mode. The first activation is a deployment and happens only in an approved
window:

1. Build and validate the exact source to deploy.
2. `node installer/install-darwin.mjs --activate-release --maintenance-approved`. It reloads every
   job, so active turns must be drained first, exactly as for a restart.
3. Check `node scripts/releases.mjs status`: every service shows `release` mode.
4. Check `/healthz`: web and runner report the release id.

Later deployments use `npm run restart -- --maintenance-approved <services>`.

Keep old releases; nothing prunes them. Remove one only after checking that it is neither an
active nor a previous pointer target. Release directories are read-only, so run `chmod -R u+w`
before removing one.
