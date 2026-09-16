# AGENTS.md — Veneer OS

For a coding agent (Claude Code, Codex, or the in-app Platform Dev agent) working in this repo.

## What this is

Veneer OS is a single, standalone Veneer install: a chat-first web app backed by locally installed
Claude Code, Codex, and Grok subscriptions, on one macOS arm64 machine.
The server binds `127.0.0.1` only; a `cloudflared` tunnel plus a Cloudflare Access application are
the entire public surface and the entire authentication story.
There is no fleet, no control plane, no remote instance, and no release step — one machine, one
install, one owner.

## Layout

- `server/` — Express 4 + ws + better-sqlite3 + zod; TypeScript strict, ESM, Node 24. Entry points
  under `src/`: `index.ts` (web), `runner/` (agents), `appRunner/` (Mini Apps), `terminalService/`.
- `web/` — Vite + React 19 + Tailwind 4 mobile-first PWA; built output served statically by server.
- `browser-manager/` — Veneer Browser manager: native Chrome, loopback listeners, bearer auth, CDP
  relay. Own workspace, plain `.mjs`, `node --test`.
- `installer/` — `install-darwin.mjs` (launchd install, preflight, provisioning) plus the
  document-tool provisioners, `env.mjs`, `backup.mjs`.
- `agent-skills/` — skills copied into agent homes; content, not application code.
- `mini-apps/` — reproducible source for published Mini App Workers.
- `deploy/launchd/` — plist templates the installer renders (`__NODE__`, `__CODE_DIR__`, `__HOME__`…).
- `scripts/` — `restart.mjs`, `boot-probe.mjs`, `boot-smoke.mjs`, migrations, backfills.
- `docs/` — `spec.md`, `protocol-notes.md` (CLI wire facts), `cloudflare-setup.md`,
  `reboot-survival.md`, dated incident notes.

## Build / test / restart loop

Run from the repo root. Everything must pass **before** a restart; a failed check must never restart
the product.

```sh
npm run typecheck                      # tsc --noEmit for server + web
npm test -w @veneer-pro/server         # vitest
npm test -w @veneer-pro/web            # vitest
npm test -w veneer-browser-manager     # node --test
npm run test:installer                 # node --test installer/*.test.mjs
npm test                               # all four, in that order
npm run build                          # server tsc (+ copies migrations) then web tsc + vite
npm run restart                        # SIGTERM by pid file; supervisors respawn
```

Scope tests while iterating; run the full set before building. Dev loop: `VP_IDENTITY=dev npm run dev`
(:3100, authenticates nobody, loopback only) and `npm run dev -w @veneer-pro/web` (vite, proxies
`/api` and `/ws`). `npm run restart` signals the four node services through their
`DATA_DIR/run/<service>.pid` files and kickstarts `com.veneer.browser-manager`; never call
`launchctl` directly for these.

## launchd services

| label | runs |
|---|---|
| `com.veneer.pro` | `server/dist/index.js` — web + API + WS, `127.0.0.1:$PORT` (3100) |
| `com.veneer.pro.runner` | `server/dist/runner/index.js` — agent execution (3101) |
| `com.veneer.pro.app-runner` | `server/dist/appRunner/index.js` — local Mini Apps (3102) |
| `com.veneer.pro.term` | `server/dist/terminalService/index.js` — ptys (3103) |
| `com.veneer.browser-manager` | `browser-manager/manager.mjs` — 7300 HTTP / 7301 HTTPS, loopback |
| `com.veneer.chrome` | headless Chrome for the desktop view, CDP on 9223 |
| `com.veneer.pro.cloudflared` | `cloudflared tunnel run --token-file ~/.config/veneer-pro/cloudflared-token` |
| `com.veneer.pro.backup` | `installer/backup.mjs`, nightly |
| `com.veneer.boot-probe` | `scripts/boot-probe.mjs`, one shot per boot |
| `com.veneer.supermemory` | optional memory server |

Logs: `~/Library/Logs/veneer-pro/`.

## Configuration and secrets

- `~/.config/veneer-pro/env` (0600) — every key; each service loads it itself, launchd has no
  `EnvironmentFile`. Schema of record: `server/src/config.ts`. Documented in `README.md`.
- `~/.config/veneer-pro/browser.env` (0600) — the Veneer Browser bearer identity, deliberately kept
  out of the main env file and never part of `Config`.
- `~/.config/veneer-pro/cloudflared-token` (0600) — the tunnel token, one line.
- `DATA_DIR` (default `~/.local/share/veneer-pro`) — SQLite DB, secrets, workspaces, transcripts,
  pid files.
- `VP_SERVICE_HOME` (default `~/veneer-pro-home`) — the services' own `HOME`, so agent state
  (`.claude`, `.codex`) never mixes with the login user's. It is **not** the login home; a path that
  works in your shell may not work in a service.

**Never print, log, echo, or paste a secret value.** Read a credential at use time and pass it
straight to its destination; never `cat` an env file into a transcript — grep the key name to
confirm it is set.

## Install and update

First install, env keys and backups: `README.md`. Cloudflare tunnel and Access, including the exact
values the server validates: `docs/cloudflare-setup.md`. Browser manager TLS material, client
registry and native backend: `browser-manager/INSTALL-MACOS.md`.

Update is `git pull` → `npm install` → `npm run build` → `npm run restart`, plus
`node installer/install-darwin.mjs` when a launchd template or a provisioned tool changed. The
installer is idempotent; `--dry-run` shows what it would do.

## Migrations

`server/src/db/migrations/*.sql`, applied in name order and recorded with a **content hash**
(`server/src/db/migrate.ts`). Editing a migration that has already been applied makes the hash
mismatch and the server refuses to start. Never edit an applied migration — add a new numbered one.
`npm run build -w @veneer-pro/server` copies the SQL into `dist/`; a migration added without a
rebuild will not run in the services.

## Native modules

`better-sqlite3` and `node-pty` are native and must match this Node major and arch. Xcode Command
Line Tools are required (`xcode-select --install`). After a Node upgrade or a broken install:

```sh
npm rebuild better-sqlite3 --build-from-source
npm rebuild node-pty --build-from-source
```

The installer's preflight spawns a real PTY through the server's `require`, so a package that loads
but cannot spawn is caught there rather than at runtime.

## Browser manager boundary

The server never talks to Chrome directly: it asks the manager for a working copy and gets a
short-lived control ticket, and every profile path derives from the authenticated client, project id
and profile UUID. Both listeners stay on `127.0.0.1` (non-loopback refused unless
`VENEER_BROWSER_ALLOW_REMOTE=1`); TLS on 7301 is required, because the ticket and CDP gates accept
only an `https://…/cdp/…` origin with a `wss:` socket. `clients.json` holds SHA-256 token hashes
only. The CDP relay refuses `Page.navigate`/`Target.createTarget` to `file:`, `chrome:`, `devtools:`,
`chrome-extension:`, `view-source:`, `chrome-untrusted:`, and download behavior pointed outside the
copy's own `downloads` directory. Never log request bodies, cookies, page data, or tickets.

## Commits

Imperative subject, no prefix or ticket ("Validate Cloudflare Access settings before installing").
Stage explicit paths — `git add <paths>`, never `git add -A`: other work may be uncommitted in the
same worktree. Commit finished, verified work; do not push or deploy without being asked. American
spelling everywhere, including identifiers and UI copy.

## Provenance

This repository was forked from Veneer Pro on 2026-09-16 and does not receive upstream updates.
Fixes in the Pro monorepo do not flow here, or vice versa; port anything you need by hand.
