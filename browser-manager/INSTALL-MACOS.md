# Installing the browser manager on macOS

On a Mac the browser manager runs beside the Pro server as a launchd agent and
drives **native Chrome processes** (`VENEER_BROWSER_BACKEND=native`) instead of
Docker containers: one headless Chrome per profile working copy, DevTools bound
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
| `VENEER_BROWSER_MAX_ACTIVE` | `5` | Concurrent sessions. |

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
