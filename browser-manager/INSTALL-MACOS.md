# Installing the browser manager on macOS

On a Mac the browser manager runs beside the Pro server as a launchd agent and
drives **native Chrome processes** (`VENEER_BROWSER_BACKEND=native`) instead of
Docker containers: one Chrome per profile working copy, DevTools bound
to 127.0.0.1, downloads forced into the profile's own `downloads` directory
through its `Default/Preferences`. The REST API, tickets, CDP relay, per-user
profile scoping, clone/promote/save, the warm pool and the bearer-token auth are
unchanged, so the Pro server needs no changes.

The TLS listener is **required**: `server/src/mcp/agentBrowser.ts` and
`server/src/channels/cdpClient.ts` only accept a `https://…/cdp/…` ticket origin
with a `wss:` socket on the same origin, and pin the certificate through
`VP_VENEER_BROWSER_LAN_CA`.

## What the installer must do

All paths below assume the Pro service home (`__HOME__`) and the checkout
(`__CODE_DIR__`).

1. **TLS material** — run once, idempotent:

   ```sh
   node __CODE_DIR__/browser-manager/scripts/local-tls.mjs
   ```

   It writes `__HOME__/.config/veneer-browser/tls/{cert.pem,key.pem}`
   (self-signed, `CN=localhost`, SAN `DNS:localhost,IP:127.0.0.1`, 10 years,
   key 0600) and prints `cert=<path>` and `key=<path>`. It does nothing if both
   files already exist; `--force` rotates them.

   The certificate is `CA:FALSE` and carries `keyUsage` without certificate
   signing. Node (via `NODE_EXTRA_CA_CERTS`) and curl (via `--cacert`) both
   accept a self-signed leaf as its own trust anchor, so the listener is trusted
   while the key cannot mint a certificate for any other name.

   **Existing installs made before this change hold a `CA:TRUE` certificate**,
   which `NODE_EXTRA_CA_CERTS` turns into a process-wide trust anchor for *any*
   hostname. Rotate it once:

   ```sh
   node __CODE_DIR__/browser-manager/scripts/local-tls.mjs --force
   npm run restart -- veneer-browser-manager
   ```

   Nothing else has to change: the paths and the pinned
   `VP_VENEER_BROWSER_LAN_CA` setting stay the same.

2. **Client token** — run once per install (re-running rotates the token):

   ```sh
   node __CODE_DIR__/browser-manager/scripts/local-client.mjs
   ```

   It writes/updates `__HOME__/.config/veneer-browser/clients.json` (0600) with
   the sha256 hash for client id `local`, and prints exactly two lines:

   ```
   VP_VENEER_BROWSER_CLIENT_ID=local
   VP_VENEER_BROWSER_TOKEN=<token>
   ```

   Append/replace those two lines in `__HOME__/.config/veneer-pro/browser.env`.
   The token is printed once and is not logged anywhere else; the manager only
   ever stores its hash.

3. **Pro server settings** — in `__HOME__/.config/veneer-pro/env`:

   ```
   VP_VENEER_BROWSER_URL=https://localhost:7301
   VP_VENEER_BROWSER_LAN_CA=__HOME__/.config/veneer-browser/tls/cert.pem
   ```

4. **launchd agent** — render `deploy/launchd/com.veneer.browser-manager.plist`
   into `__HOME__/Library/LaunchAgents/com.veneer.browser-manager.plist`,
   replacing `__NODE__`, `__CODE_DIR__`, `__LOG_DIR__`, `__HOME__`, `__PATH__`
   and `__CHROME__` (the Chrome binary, normally
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), then:

   ```sh
   launchctl bootout gui/$(id -u)/com.veneer.browser-manager 2>/dev/null || true
   launchctl bootstrap gui/$(id -u) __HOME__/Library/LaunchAgents/com.veneer.browser-manager.plist
   ```

   Chrome must be installed; the manager refuses to boot without a binary
   (Chromium and Chrome Canary are accepted fallbacks when
   `VENEER_BROWSER_CHROME_BIN` is unset).

5. **Verify**:

   ```sh
   curl -s --cacert __HOME__/.config/veneer-browser/tls/cert.pem https://localhost:7301/health
   # {"ok":true,"service":"veneer-browser-manager"}
   ```

Nothing else is needed: no Docker, no runtime image, no seccomp profile, no LUKS
mount. The store is created on first boot at
`__HOME__/Library/Application Support/veneer-browser/store` (0700, covered by
FileVault).

## Environment

| Variable | Default (darwin) | Purpose |
| --- | --- | --- |
| `VENEER_BROWSER_BACKEND` | `native` (`docker` on linux) | Process backend. |
| `VENEER_BROWSER_CHROME_BIN` | first of Chrome / Chrome Canary / Chromium | Chrome binary for the native backend. |
| `VENEER_BROWSER_HEADLESS` | `1` | `0` launches a visible Chrome instead of `--headless=new`. |
| `VENEER_BROWSER_STORE` | `$HOME/Library/Application Support/veneer-browser/store` | Profile store. |
| `VENEER_BROWSER_CLIENTS_FILE` | `$HOME/.config/veneer-browser/clients.json` | Token registry. |
| `VENEER_BROWSER_BIND` | `127.0.0.1` (`0.0.0.0` on linux) | Listener address. A non-loopback value is refused on macOS without the next setting, and the plain listener stays on loopback whenever TLS is configured. |
| `VENEER_BROWSER_ALLOW_REMOTE` | unset | `1` accepts a non-loopback `VENEER_BROWSER_BIND` on macOS. |
| `VENEER_BROWSER_REQUIRE_ENCRYPTED` | unset | `1` refuses to start when FileVault is off, instead of warning. |
| `VENEER_BROWSER_MANAGER_PORT` | `7300` | Plain HTTP listener. |
| `VENEER_BROWSER_TLS_PORT` / `_CERT` / `_KEY` | unset | TLS listener; all three or none. |
| `VENEER_BROWSER_PUBLIC_ORIGIN` | unset | Forces the origin minted into tickets (`https://localhost:7301`). |
| `VENEER_BROWSER_WARM` / `_WARM_MAX` | `1` / `2` | Pre-booted copy per saved profile, and the pool cap. |
| `VENEER_BROWSER_MAX_ACTIVE` | `5` | Running sessions across all projects; saved profiles do not add capacity. |

## Native backend notes

- Live browsers survive a manager restart. `STORE/runtime/native-processes.json`
  records pid, port, profile and warm labels; at boot the manager drops records
  whose pid is gone or no longer a Chrome on that profile, and kills a survivor
  whose profile directory has been removed.
- Stopping asks Chrome to close over CDP (so cookies and leveldb are flushed
  before a clone or promote), then SIGTERM, then SIGKILL after 5s.
- Each launch claims a fresh loopback port from the kernel, so unlike Docker the
  manager never hands a recycled port to a stale ticket.
- There is no container boundary: the isolation is the per-profile
  `--user-data-dir`, the 0700 store, and the CDP relay's blocklist (`file:`,
  `chrome:`, `devtools:`, `chrome-extension:`, `view-source:` and
  `chrome-untrusted:` navigations, plus any download path outside the copy's own
  `downloads` directory). Keep both listeners on loopback.
- Chrome is launched without `--remote-allow-origins`, so it rejects any DevTools
  WebSocket upgrade that carries a browser `Origin` header. That is what keeps a
  page in the operator's own browser from reaching the loopback CDP port; the
  manager dials it from Node, which sends no `Origin`.
- The store is only as private as the disk. At boot the manager reads
  `fdesetup status` and prints a loud warning when FileVault is off; set
  `VENEER_BROWSER_REQUIRE_ENCRYPTED=1` to make that fatal instead.
- `npm run restart` (repo root) bounces the manager along with the Pro services
  through `launchctl kickstart -k com.veneer.browser-manager`, and skips it
  quietly when the job is not loaded.


## Capacity and project growth

Runtime admission is serialized across projects, including adoption of prewarmed
copies. The default is five active sessions on this 16 GB Mac
(`VENEER_BROWSER_MAX_ACTIVE`), of which one project may hold at most two
(`VENEER_BROWSER_MAX_PER_PROJECT`, default 2), plus up to two unclaimed warm copies.
An unfiled chat's scope is its owner's private project, so unfiled chats share a
per-person cap. Warm copies consume memory even though they are not active sessions
and are built subject to the machine cap only; the project cap applies when one is
adopted. This install uses visible native Chrome (`VENEER_BROWSER_HEADLESS=0` in the
installed launch agent); headless mode is not an extra pool of capacity.

Use saved profiles for distinct business/account identities, and assign those
profiles only to authorized projects. Each chat has an independent working copy.
Adding profiles does not increase the runtime limit. Public HTML/plain-text research
should use `read_public`: it needs no Chrome slot or saved profile. Rendered work
still uses an isolated working copy. Prefer existing authorized connectors for
structured work. Do not route around an unavailable signed-in browser using another
identity.

### Lifecycle (September 29, 2026)

A working copy gives up its slot when its chat's turn ends. The runner observes the
conversation status bus and asks the application to suspend the copy at once; a
five-minute idle backstop in the once-a-minute sweep catches a copy whose turn-end
release was missed. Suspension stops Chrome and keeps the working directory
(profile data, sign-in, downloads); the next command restarts the same copy. Explicit
Stop still discards the copy. In-memory page state (a half-filled form, an open
wizard) does not survive suspension: that is the accepted trade for slots that
actually free up. Page state is no longer inspected.

What keeps a copy running is only a current condition with an end: a pending turn,
an unfinished secret fill, Advanced capture, an explicit hold, a connected viewer
(plus `VENEER_BROWSER_VIEWER_GRACE_SECONDS`, default 120, after the last viewer
disconnects), a viewer ticket that has not connected yet, or a Chrome download in
progress. Keep open (panel switch or the bot `keep_open` tool, which requires a
reason) records an expiry of at most two hours; renewing means asking again, and a
hold recorded without an expiry, or a started sign-in, lapses two hours after it was
recorded. An action with an unknown outcome is kept in the audit trail and reported
to the bot on reopen as needing verification; it no longer pins the copy, and nothing
is ever replayed. The application's own agent ticket and automation socket are not
ownership: they are closed at suspension.

Starts enter an admission queue capped at 32 waiters, waiting up to 20 seconds for a
slot. `VENEER_BROWSER_CAPACITY_WAIT_MS` may shorten this timeout (100–20000 ms).
Arrival order is kept while the whole machine is full; a waiter refused only by its
own project's cap steps aside for later waiters from other projects. The waiting
queue does not hold the runtime lock. A timed-out/disconnected waiter is removed;
no browser command or unknown-effect request is replayed. This queue is intentionally
not durable across manager restart. Above it, the application layer persists
owner-bound capacity continuations in SQLite. A bot Open capacity timeout
automatically creates a one-hour wait; explicit `wait_for_capacity` supports up to
two hours, with at most 32 pending waits globally. No navigation or mutation is saved.
After the requesting turn ends, maintenance admits eligible waiters in arrival order,
skipping a waiter whose project is at its cap while the machine has room, and creates
one existing-platform wake in the same transaction as its result. Active requesting
chats are skipped. Actual start and warm-copy adoption still enforce both caps
atomically.

Waits survive runner restarts. An interrupted allocation only reconciles a known
active copy; an unknown outcome generates a failure wake, never a blind new start.
Keys are idempotent for identical scope/task/deadline duration. Owner, profile,
project, native provider session or new human instruction changes invalidate the
old continuation, rechecked again at wake dispatch. Cancel wait cancels pending
allocation and an undelivered wake; it never kills a copy already allocated. Stop
also cancels waiting. Expiration emits one blocker wake, not an endless retry.
An automatic wait is not renewed for the same unchanged task context. On wake the
bot must inspect current state and original authority before doing any work.

`read_public` accepts only public HTTP(S) HTML/plain text, uses no cookie jar,
Authorization, saved profile, scripts or Chrome, validates DNS and pins the approved
address on each connection, and revalidates redirects. Private/local ranges and
credential URLs are rejected. Four concurrent requests, 30-second deadlines,
2 MiB response limits and bounded text output limit its resource use. HTTP reads
cannot supply JavaScript rendering, private account data, videos or guaranteed
captions. There is no hidden extra Chrome pool.

Idle checks now distinguish checked state from a checkbox's default "on" value.
Only explicit search controls whose unchanged query is already in the URL are
recoverable without retaining the page. Edited search text, ordinary hydrated
forms, password fields, editors, and exit handlers stay protected. This is a narrow
false-positive correction, not permission to discard arbitrary page state.

The panel shows global counts and names of occupying chats only when its user already
has browser access to them. It shows this copy's last retention reason and Keep open
setting. Retention reasons are audited without raw errors or page content. Capacity
exhaustion is a bounded 429 response, not a runner HTTP500 traceback. No profile,
credential, or business-action permission changes are implied by waiting or release.

Keep the five-session default on the current 16 GB Mac until measured concurrent
work warrants a change. First check completed sessions and protected owners, memory
pressure, Chrome process counts, and warm-pool usage. A higher limit or more hardware
is an operator capacity decision, not a reason to duplicate signed-in profiles.
