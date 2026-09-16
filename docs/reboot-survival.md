# Reboot and power-loss survival

The requirement: if a host loses power, everything comes back on its own. No
human, no login by hand, no "did the tunnel reconnect?" A server that needs a
person to restart it is not a server.

This documents the chain, what was verified, and how to re-verify it.

## macOS

The chain, from the outage to the site being live again:

| Link | Mechanism | Where |
|---|---|---|
| Power returns, the Mac boots itself | `pmset autorestart 1` | `pmset -g custom` |
| Boot reaches a GUI session with no keyboard | Auto-login for the install's user | `/Library/Preferences/com.apple.loginwindow autoLoginUser` |
| Disk is readable at boot | FileVault **off** — no unlock prompt | `fdesetup status` |
| Services start | LaunchAgents, `RunAtLoad` + `KeepAlive` | `~/Library/LaunchAgents/com.veneer.*` |
| Tunnel comes back | LaunchDaemon (boot-level, no login needed) | `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` |
| Somebody finds out it worked | `com.veneer.boot-probe` emails the verdict | `scripts/boot-probe.mjs` |

### Why auto-login rather than LaunchDaemons

LaunchDaemons start at boot without a login, which looks like the stronger
answer. It isn't, here: the `claude` and `codex` CLIs keep their OAuth
credentials in the macOS **login Keychain**, and a boot-time daemon context has
no unlocked login keychain. Agent turns would fail on a box that otherwise
looked perfectly healthy — the worst kind of outage, because every service is
green.

Auto-login keeps the login keychain unlocked and the GUI session alive, which is
what every agent already targets. The tradeoff is a machine that boots to an
unlocked desktop; it is accepted deliberately, and mitigated by the screen lock
below. This assumes the machine sits in physically controlled space.

Two settings make the keychain part actually hold:

- The login keychain is set to **no-timeout** (`security show-keychain-info`).
  It does not re-lock on idle.
- Sleep is disabled entirely, so there is no sleep event to lock it either.

### Power settings

```sh
sudo pmset -a sleep 0 displaysleep 10 disksleep 0 womp 1 autorestart 1
```

- `sleep 0` — a sleeping server is as gone as a powered-off one.
- `disksleep 0` — no spin-down under a service that writes SQLite continuously.
- `displaysleep 10` — the display is the one thing that *should* go away.
- `autorestart 1` — boot automatically after a power failure. This is the link
  the whole chain hangs from.
- `womp 1` — wake on network.

### Screen lock

Auto-login means the desktop is sitting open after an unattended boot, so the
screensaver locks it shortly after:

```sh
defaults -currentHost write com.apple.screensaver askForPassword -int 1
defaults -currentHost write com.apple.screensaver askForPasswordDelay -int 60
defaults -currentHost write com.apple.screensaver idleTime -int 600
```

Screen lock is not keychain lock — the session stays alive and the agents keep
running behind it. Do **not** turn off auto-login to "fix" this; that breaks the
keychain chain above.

Note: `sysadminctl -screenLock status` reports `28800 seconds` on this host
regardless of the above. It reads a managed-profile value, and no configuration
profile is installed (`profiles show -type configuration` is empty), so it is
reporting its own default for an unset setting rather than the effective one.
The `-currentHost` keys are what System Settings writes and what the screensaver
reads.

### The agents

All five Pro agents plus Core veneer carry `RunAtLoad` **and** `KeepAlive`:

| Label | Purpose |
|---|---|
| `com.veneer.pro` | web + API (`:3100`) |
| `com.veneer.pro.runner` | agent execution (`:3101`) |
| `com.veneer.pro.app-runner` | local Mini Apps (`:3102`) |
| `com.veneer.supermemory` | self-hosted Supermemory (`:6767`) |
| `com.veneer.chrome` | shared headless Chrome, CDP on `:9223` |
| `com.veneer.boot-probe` | post-boot verification, one shot |

`com.cloudflare.cloudflared` shipped with `KeepAlive = {SuccessfulExit = false}`
— it would restart after a crash but stay down after any clean exit, taking the
public site with it. Changed to `KeepAlive = true`. (A `launchctl bootout` still
stops it; `KeepAlive` only governs the process exiting on its own.)

### The boot probe

Configuration is not evidence. `com.veneer.boot-probe` runs once per boot,
settles for 20s, then checks every hop out to the public edge, retrying each
until it passes or a 5-minute deadline:

- `veneer-pro web` — `GET :3100/healthz`
- `veneer-pro runner` — `GET :3101/healthz` (directly, not through web's proxy,
  which hides which of the two is down)
- `veneer-pro app-runner` — `POST :3102/rpc/statuses` (RPC-only; a GET reports a
  healthy process as 405)
- `supermemory` — `GET :6767/v3/health` when Supermemory is installed
- `desktop chrome (cdp)` — `GET :9223/json/version`
- `public edge (tunnel)` — `GET $VP_BOOT_PROBE_URL`, expecting the 302 to
  Cloudflare Access. **This is the only check that proves the tunnel**: loopback
  health says nothing about whether `cloudflared` reconnected. Skipped when the
  variable is unset.
- host extras from `VP_BOOT_PROBE_EXTRA` (`label=url[,label=url...]`).

It writes `~/veneer-boot-report-<timestamp>.txt` (last 10 kept). Email is opt-in:
set `VP_BOOT_PROBE_EMAIL` and `VP_BOOT_PROBE_FROM`, plus either `RESEND_API_KEY`
or `VP_BOOT_PROBE_RESEND_PROJECT` so the key can be read from Doppler at send
time. No credential is written into a plist or this repo — Doppler's own token
lives in `~/.doppler`, not the login Keychain, so it resolves in a launchd
context.

The probe is deliberately standalone: no npm dependencies and no imports from
`server/dist`. The report matters most on the boot where the build is broken, so
it must not share a failure mode with the thing it reports on.

Run it by hand:

```sh
node scripts/boot-probe.mjs --now            # check + email
node scripts/boot-probe.mjs --now --no-email # check only
```

A run at an uptime of hours or days is tagged `[manual run, uptime Nh]` in the
subject, so an out-of-nowhere "boot report" is never mistaken for an
unexplained reboot.

Host-specific settings live in `~/.config/veneer-pro/env`, not in this repo:
`VP_BOOT_PROBE_EXTRA`, `VP_BOOT_PROBE_URL`, `VP_BOOT_PROBE_EMAIL`,
`VP_BOOT_PROBE_FROM`, `VP_BOOT_PROBE_HOST`.

## Known limitations

- **The probe cannot report on a host that never boots.** It proves recovery
  happened; it cannot prove recovery *will* happen. That is what the reboot test
  is for, and why it is worth actually doing rather than reasoning about.
- **A green report means the services are up, not that the data is reachable.**
  Every check here is liveness. Claude transcript paths, for instance, are
  recomputed from the agent's *current* working directory on every read, so a
  change to `VP_SOURCE_DIR`, `HOME`, or `DATA_DIR` makes prior transcripts go
  dark while every check above still passes. A reboot does not change those
  variables, so this is not a reboot risk — but do not read "all checks green"
  as "everything is fine" after a *migration*.

## Re-running the test

```sh
sudo reboot
```

Then read the report (or wait for the email, if it is configured). Everything
above is arranged so that is the whole procedure. Check no agent is mid-flight
first — a reboot kills every running agent session on the host — and warn
anyone using it, because the site goes away for a minute or two.

If the report says FAIL, the failing check names the hop: loopback checks point
at a launchd agent, and the edge check points at `cloudflared`.
