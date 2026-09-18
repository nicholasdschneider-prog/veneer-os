# Veneer OS

A single, standalone Veneer install: a chat-first web app backed by locally installed Claude Code,
Codex, and Grok subscriptions, running on one macOS arm64 machine. Cloudflare Access sits in front
of it, reached through a `cloudflared` tunnel to loopback — the server itself never binds a public
interface.

There is no fleet, no control plane, and no remote instance. One machine, one install, one owner.

## Layout

- `server/` — Express 4 + ws + better-sqlite3 + zod (TypeScript strict, ESM, Node 24). Binds
  127.0.0.1 only. Runs as four services: web, runner (agent execution), app-runner (Mini Apps),
  and the terminal service.
- `web/` — Vite + React 19 + Tailwind 4 mobile-first PWA. Built output is served statically by
  the server.
- `installer/` — `install-darwin.mjs` plus the document-tool provisioners.
- `deploy/launchd/` — launchd agent templates the installer renders.
- `browser-manager/` — the local Veneer Browser manager: native Chrome, loopback only (see below).
- `docs/spec.md` — the build spec. `docs/protocol-notes.md` — verified Claude CLI wire facts.
  `docs/cloudflare-setup.md` — the tunnel and Access setup.
- `AGENTS.md` — instructions for a coding agent working in this repository (`CLAUDE.md` points at it).

## Prerequisites

| | |
|---|---|
| macOS arm64 | required; the installer refuses to run elsewhere |
| Node 24 (`>=24 <25`) | see `.node-version` |
| Xcode Command Line Tools | `xcode-select --install` — native modules build from source |
| Google Chrome | the shared desktop browser and the agent browser both drive it |
| `cloudflared` | at `~/.local/bin/cloudflared`, `/opt/homebrew/bin`, or `/usr/local/bin` |
| A Cloudflare Access application | over the tunnel hostname, with your email allowed — [docs/cloudflare-setup.md](docs/cloudflare-setup.md) |
| Doppler CLI | **optional** — enables the secret vault (`request_secret` / `reveal_secret`) |

## Install

```sh
git clone <this repo> ~/veneer-os && cd ~/veneer-os
npm install
npm run build                       # server (tsc) + web (tsc + vite)

mkdir -p ~/.config/veneer-pro
$EDITOR ~/.config/veneer-pro/env    # see the env keys below; chmod 600
chmod 600 ~/.config/veneer-pro/env

# The Cloudflare Tunnel token, on its own line, no quotes:
printf '%s' '<tunnel token>' > ~/.config/veneer-pro/cloudflared-token
chmod 600 ~/.config/veneer-pro/cloudflared-token

node installer/install-darwin.mjs
```

- **Cloudflare tunnel and Access** — creating the tunnel, the Access application, the AUD tag and the policy, and the exact values `VP_CF_TEAM_DOMAIN` / `VP_CF_AUD` must hold: [docs/cloudflare-setup.md](docs/cloudflare-setup.md).
- **Working on this repository as an agent** — layout, the build/test/restart loop, and the rules a coding agent must follow: [AGENTS.md](AGENTS.md).

The installer writes the launchd agents to `~/Library/LaunchAgents`, provisions the shell profile,
the Agent Browser and the local browser manager (TLS material, bearer token, env wiring — see
**Veneer Browser** below), and loads every service. It is idempotent — re-run it whenever the service
definitions change. Add `--dry-run` to see what it would do.

Then open your Access-protected hostname. The first authenticated visitor to an empty database gets
the setup screen and becomes the `owner`. After that, any other email Cloudflare Access lets through
is auto-provisioned on its first `GET /api/me` as a `member` with status `pending`: it sees the
"Waiting for approval" screen and every other route answers 403 until an admin approves it in
**Settings → People & access**. There is no self-signup — passing Access is necessary but not
sufficient.

### Scripted owner seed

The setup screen is the normal path. To create the owner (and any consultant
accounts) without it — a scripted or headless install — run the seeder against a
built checkout. It upserts by email and is safe to re-run:

```sh
npm run build -w @veneer-pro/server
node server/dist/installer/seed.js \
  --data-dir ~/.local/share/veneer-pro \
  --owner-email you@example.com \
  --owner-name 'Your Name' \
  --consultant helper@example.com:Helper      # optional, repeatable
```

The `claude`, `codex`, and `grok` CLIs must be logged in. Preferred: **Settings → Providers →
Connect** runs the device-auth / `setup-token` flow in-app and stores the result in
`DATA_DIR/secrets.json` (0600). An interactive CLI login also works.

## Update

```sh
cd ~/veneer-os
git pull
npm install
npm run build
npm run restart
```

Re-run `node installer/install-darwin.mjs` too if the launchd templates or the provisioned tools
changed.

## Environment

All keys live in `~/.config/veneer-pro/env` (0600), which each service loads for itself — launchd
has no `EnvironmentFile`.

### Required

| var | notes |
|---|---|
| `VP_IDENTITY` | `cloudflare` (default). `dev` disables authentication and is localhost-only. |
| `VP_CF_TEAM_DOMAIN` | required in `cloudflare` mode, e.g. `acme.cloudflareaccess.com` |
| `VP_CF_AUD` | required in `cloudflare` mode — the Access application's AUD tag |

The server refuses to start in `cloudflare` mode without both Cloudflare values: it fails closed
rather than silently granting owner access to every caller.

### Core

| var | default | notes |
|---|---|---|
| `PORT` | `3100` | the web service; always binds 127.0.0.1 |
| `DATA_DIR` | `~/.local/share/veneer-pro` | SQLite DB, secrets, workspaces, transcripts |
| `VP_SERVICE_HOME` | `~/veneer-pro-home` (installer) | the services' own `HOME`, so agent state never mixes with the login user's |
| `VP_SOURCE_DIR` | `~/veneer-pro` | source checkout an agent may edit, build, and restart |
| `VP_CLIENT_NAME` | — | optional workspace name used as the browser title |
| `VP_DEV_EMAIL` | `owner@example.com` | the identity attributed to every request under `VP_IDENTITY=dev` |
| `VP_RUNNER_PORT` | `3101` | loopback IPC for the agent-execution service |
| `VP_APP_RUNNER_PORT` | `3102` | loopback IPC for local Mini Apps |
| `VP_TERM_PORT` | `3103` | loopback IPC for the terminal service |
| `VP_CLAUDE_BIN` / `VP_CODEX_BIN` / `VP_GROK_BIN` | `claude` / `codex` / `grok` | the installer pins these to the service home's `.local/bin` |

### Turn limits

| var | default | notes |
|---|---|---|
| `VP_TURN_INACTIVITY_MS` | `900000` | a turn with no provider activity for 15 min is reaped; a pending approval or a running tool call suspends the clock, poll-style `wait`/`list` calls do not |
| `VP_TURN_TIMEOUT_MS` | `21600000` | absolute ceiling: no turn outlives 6 h, however busy it looks |
| `VP_APPROVAL_TIMEOUT_MS` | `600000` | how long an unanswered approval card blocks a turn |

### Optional services

| var | default | notes |
|---|---|---|
| `SONIOX_API_KEY` | — | default key for realtime dictation; **Settings → API Keys** overrides it |
| `OPENROUTER_API_KEY` | — | default OpenRouter key; **Settings → API Keys** overrides it |
| `SUPERMEMORY_BASE_URL` | `http://127.0.0.1:6767` | self-hosted shared memory |
| `SUPERMEMORY_API_KEY` | — | unset disables memory; chats are unaffected |
| `COMPOSIO_API_KEY` | — | hosted connectors (Gmail etc., `#/connectors`) |
| `COMPOSIO_WEBHOOK_SECRET` | — | verifies provider events at `POST /webhooks/composio`; the project webhook secret, not the API key |

### Desktop and browser

| var | default | notes |
|---|---|---|
| `VP_DESKTOP_MODE` | `vnc` | set to `cdp` on macOS — it streams the shared Chrome over DevTools and needs no display server |
| `VP_DESKTOP_CDP_PORT` | `9223` | loopback DevTools port of the shared Chrome |
| `VP_VENEER_BROWSER_URL` | `https://localhost:7301` | the Veneer Browser manager's base URL — the local manager by default |
| `VP_VENEER_BROWSER_CLIENT_ID` / `VP_VENEER_BROWSER_TOKEN` | — | browser bearer identity; written by the installer to `~/.config/veneer-pro/browser.env` (0600) so it stays out of the main env file |
| `VP_VENEER_BROWSER_IDENTITY_FILE` | — | explicit path to that identity file; the installer points it at `browser.env` |
| `NODE_EXTRA_CA_CERTS` | — | the manager's loopback certificate. Set by the installer, and also rendered into the web and runner plists, because Node reads it only at process start |
| `VP_VENEER_BROWSER_LAN_URL` / `VP_VENEER_BROWSER_LAN_CA` | — / cert path | LAN shortcut to a manager on *another* host; `https://` only, with a pinned certificate. A local manager needs no shortcut, so the installer sets only the CA path |
| `VP_EMAIL_CODE_MAILBOX` | — | enables the browser's `fill_email_code` tool: the one mailbox whose emailed verification codes the runner may read, through the **shared** Gmail connector labeled with this address (exactly one must match) |
| `VP_EMAIL_CODE_SENDERS` | — | comma-separated sender addresses or domains a code may come from; the agent can narrow but never widen it |
| `VP_EMAIL_CODE_CONNECTOR_ID` | — | pins a `user_connectors` row id when more than one shared install carries the label |
| `VP_LAN_VIEWER_HOST` / `VP_LAN_VIEWER_PORT` / `VP_LAN_VIEWER_CERT` / `VP_LAN_VIEWER_KEY` | — `3443` — — | direct LAN listener for the live browser view; all four needed for it to start |

### Publishing (all optional)

| var | default | notes |
|---|---|---|
| `VP_PAGES_CF_ACCOUNT_ID` | falls back to `VP_APPS_CF_ACCOUNT_ID` | Cloudflare account holding the pages R2 bucket |
| `VP_PAGES_CF_API_TOKEN` | falls back to `VP_APPS_CF_API_TOKEN` | R2 Storage Write |
| `VP_PAGES_BUCKET` | `veneer-pages` | R2 bucket for published pages |
| `VP_PAGES_PUBLIC_BASE` | — | public origin for published pages; page publishing stays off until it is set |
| `VP_APPS_CF_ACCOUNT_ID` | — | Cloudflare account that owns this install's Mini App Workers |
| `VP_APPS_CF_API_TOKEN` | — | Workers Scripts Write + Workers Routes Write + R2 Storage Write |
| `VP_APPS_CF_ZONE_ID` | — | zone containing this install's hostname |
| `VP_APPS_PUBLIC_ORIGIN` | — | this install's public origin, e.g. `https://veneer.example`; without it agent-facing links fall back to `http://127.0.0.1:$PORT` |

Publishing stays disabled unless the account id, the API token, **and** the public base are all
present.

### Boot probe (optional)

`scripts/boot-probe.mjs` verifies every service after a reboot and writes a report to the home
directory. Every key is optional; unset ones simply skip that check.

| var | notes |
|---|---|
| `VP_BOOT_PROBE_URL` | public edge to probe; unset skips the tunnel check |
| `VP_BOOT_PROBE_EXTRA` | extra checks as `label=url[,label=url...]` |
| `VP_BOOT_PROBE_EMAIL` / `VP_BOOT_PROBE_FROM` | both needed to email the report |
| `RESEND_API_KEY` or `VP_BOOT_PROBE_RESEND_PROJECT` | the Resend key, directly or read from Doppler at send time |
| `VP_BOOT_PROBE_HOST` | label for the subject line; defaults to the hostname |

See `docs/reboot-survival.md` for the full power-loss recovery chain.

## Veneer Browser

The Veneer Browser — the real, signed-in browser agents drive — runs **on this same Mac**. There is
no browser VM and no Docker: `com.veneer.browser-manager` drives native Chrome processes
(`VENEER_BROWSER_BACKEND=native`), one per profile working copy, and both of its listeners stay on
loopback. See `browser-manager/INSTALL-MACOS.md` for the manager's own reference.

`node installer/install-darwin.mjs` sets all of it up, idempotently:

1. Runs `browser-manager/scripts/local-tls.mjs` with `HOME` set to the service home, creating the
   self-signed loopback certificate (`CN=localhost`, SAN `DNS:localhost,IP:127.0.0.1`, 10 years).
   Existing material is kept; `--force` on that script rotates it.
2. Runs `browser-manager/scripts/local-client.mjs --client local`, which records the sha256 hash of
   a fresh bearer token in the manager's registry and prints the token exactly once. The installer
   writes it straight into `browser.env` and never logs it. Re-running the installer rotates it.
3. Fills in the Pro server's wiring in `~/.config/veneer-pro/env`, each key only if it is not
   already set, so an operator pointing this install at some other manager keeps their values.
4. Renders and loads `com.veneer.browser-manager` alongside the other launchd agents.

### Files it creates

| path | mode | what |
|---|---|---|
| `$VP_SERVICE_HOME/.config/veneer-browser/tls/{cert.pem,key.pem}` | `644` / `600` | the loopback TLS pair the manager serves |
| `$VP_SERVICE_HOME/.config/veneer-browser/clients.json` | `600` | client registry — token **hashes** only |
| `$VP_SERVICE_HOME/Library/Application Support/veneer-browser/store` | `700` | profile store, created by the manager on first boot |
| `~/.config/veneer-pro/browser.env` | `600` | `VP_VENEER_BROWSER_CLIENT_ID` + `VP_VENEER_BROWSER_TOKEN`; the server refuses to read it if any other account can |

### Ports

| port | |
|---|---|
| `7300` | plain HTTP, `127.0.0.1` only |
| `7301` | HTTPS, `127.0.0.1` only — the one the Pro server uses. `https` is not optional: the ticket and CDP gates accept only an `https://…/cdp/…` origin with a `wss:` socket on the same origin |

The certificate is self-signed, so every service that dials `https://localhost:7301` has to trust it.
Node reads `NODE_EXTRA_CA_CERTS` once at process start — before it would load `~/.config/veneer-pro/env`
itself — so the installer renders that variable into the `com.veneer.pro` and `com.veneer.pro.runner`
plists as well as writing it to the env file (where it serves `npm run dev` and human readers).

### Health

```sh
curl -sS --cacert ~/veneer-pro-home/.config/veneer-browser/tls/cert.pem https://localhost:7301/health
# {"ok":true,"service":"veneer-browser-manager"}

launchctl print gui/$(id -u)/com.veneer.browser-manager | head
tail -f ~/Library/Logs/veneer-pro/veneer-browser-manager.log
```

## Dev loop

```sh
VP_IDENTITY=dev npm run dev              # tsx watch on :3100, identity fixed to VP_DEV_EMAIL
npm run dev -w @veneer-pro/web           # vite, proxies /api and /ws to :3100
```

`VP_IDENTITY=dev` authenticates nobody. Never use it on a host reachable from anywhere but loopback.

```sh
npm run build        # server tsc + web tsc/vite
npm run typecheck    # tsc --noEmit for both workspaces
npm test             # installer + server + web + browser-manager
npm run restart      # restart the launchd services
```

## Backups

`installer/backup.mjs` runs nightly through `com.veneer.pro.backup` and keeps `VP_BACKUP_KEEP`
(default 7) daily archives in `VP_BACKUP_DIR` (default `~/.local/share/veneer-pro-backups`).
To restore one:

```sh
installer/restore-backup.sh ~/.local/share/veneer-pro-backups/veneer-pro-YYYYMMDDTHHMMSSZ.tar.gz
```

The restore script stops the application processes, moves the current data aside rather than
deleting it, restores the archive, and starts the services again.
