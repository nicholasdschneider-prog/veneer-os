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

As of September 28, 2026, runtime admission is serialized across projects, including
adoption of prewarmed copies. The default is five active sessions plus up to two
unclaimed warm copies. Warm copies consume memory even though they are not active
sessions. This install uses visible native Chrome (`VENEER_BROWSER_HEADLESS=0` in
the installed launch agent); headless mode is not an extra pool of capacity.

Use saved profiles for distinct business/account identities, and assign those
profiles only to authorized projects. Each chat has an independent working copy.
Adding profiles does not increase the runtime limit. Public HTML/plain-text research should use `read_public`: it needs no Chrome
slot or saved profile. Rendered work still uses an isolated working copy. Projects
without a saved profile can allocate a signed-out copy when rendering is required. Explicit Fresh/sign-in
sessions stay protected. Prefer existing authorized
connectors for structured work and public reads when browser interaction is not
needed. Do not route around an unavailable signed-in browser using another identity.

The September 28 follow-up replaces permanent past-view/click protection. The
application checks idle copies once per minute and before allocating a cold copy.
After 30 minutes without application commands it considers copies with no pending
turn, capture, sign-in field, explicit Keep open hold, or unresolved action. A
successful old click is not proof that business work completed; it merely stops
being a permanent veto. Failed/uncertain actions remain protected, even after later
reads. Absent or malformed history fails closed.

The browser manager then checks connected viewers, a 30-minute viewer grace period,
unexpired tickets, unchanged activity, in-progress Chrome downloads, every page and
frame, filled form fields, editable regions and beforeunload handlers. Only boolean
safety results leave Chrome; no page values, URLs or credentials enter diagnostics.
An unavailable or failed inspection prevents suspension. Dead automation sockets can
be disconnected after these checks even when closing the local daemon failed. Live
viewer sockets have ping/pong liveness detection. Historical humanProtected metadata
is no longer an indefinite veto.

Use Keep open (in the panel or the bot keep_open tool) for work whose in-memory state
must survive, including unfinished business workflows waiting for human input. Fresh
sign-in sessions start held; a successful sign-in does not implicitly release the
hold. Turning it off permits safety checks, not business execution or uncertain-action
replay. Browser files/downloads are retained on automatic suspension, and the same
working copy restarts on next use. Explicit Stop still discards that working copy.
Chrome attempts session restoration; old element refs and arbitrary in-memory app
state are not a resume guarantee. Saved login bases are never automatically updated.

Starts enter a FIFO queue capped at 32 waiters, waiting up to 20 seconds for a slot.
`VENEER_BROWSER_CAPACITY_WAIT_MS` may shorten this timeout (100–20000 ms). The waiting
queue does not hold the runtime lock: suspensions and ongoing work can free capacity.
Warm-copy adoption shares admission. A timed-out/disconnected waiter is removed;
no browser command or unknown-effect request is replayed. This queue is intentionally
not durable across manager restart. Above it, the September 29 application layer
persists owner-bound capacity continuations in SQLite. A bot Open capacity timeout
automatically creates a one-hour wait; explicit `wait_for_capacity` supports up to
two hours, with at most 32 pending waits globally. No navigation or mutation is saved.
After the requesting turn ends, maintenance admits one eligible waiter in arrival
order and creates one existing-platform wake in the same transaction as its result.
Active requesting chats are skipped. Before foreground cold allocation, older
eligible durable waiters get an admission opportunity. Actual start and warm-copy
adoption still enforce the global manager cap atomically.

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
