# Veneer Browser manager

The service that owns this machine's logged-in browser profiles. The Pro server
never talks to Chrome directly: it asks the manager for a working copy and gets
back a short-lived control ticket, and every profile path is derived from the
authenticated client, project ID and profile UUID.

`VENEER_BROWSER_BACKEND` picks how a copy is run, defaulting to the platform:

- **`native` (macOS, the default here)** — one Chrome process per working copy,
  launched by the manager beside the Pro server, headless unless
  `VENEER_BROWSER_HEADLESS=0`, DevTools on a fresh loopback port each time.
  **Install and configuration: [INSTALL-MACOS.md](INSTALL-MACOS.md).**
- **`docker` (Linux)** — one resource-limited container per working copy, Chrome
  as UID 10001 with its sandbox on. See "Linux/Docker backend" below.

Everything above the backend is shared: the REST API, tickets, the CDP relay,
per-client profile scoping, clone/promote/save, the warm pool, and the
bearer-token auth.

## Rules that hold on every backend

- Saved profiles are stopped login bases. Each chat gets its own temporary
  working copy; a clean stop deletes it, and an idle one is deleted after
  `VENEER_BROWSER_TEMP_IDLE_MINUTES` (30 by default) unless its control
  connection is still open.
- Updating a saved profile is explicit: the manager stops the working copy,
  checks the source generation and keeps a prior backup, and an older copy can
  never replace a newer saved profile.
- A signed-out browser is temporary. It becomes a saved profile only through an
  explicit save-as.
- Keep the client registry (`clients.json`) readable only by the account that
  runs the manager, and store SHA-256 token hashes only.
- Never log request bodies, cookies, page data, clipboard data, or control
  tickets.
- The web and runner services can restart without stopping live browsers.
- A working copy cannot answer a passkey prompt: the manager holds one
  DevTools session per temporary copy that installs an empty virtual
  authenticator on every page (`webauthn.mjs`), so `navigator.credentials.get()`
  rejects within milliseconds and passkey-first sites fall back to their
  password path instead of spinning forever. Saved profiles a person opens in
  the live browser view are left alone. `VP_BROWSER_ALLOW_PASSKEYS=1` in the
  manager's environment switches the block off.

## What the CDP relay refuses

`cdp-relay.mjs` forwards client commands to Chrome, minus a short blocklist,
because on the native backend Chrome runs as the same account as the manager and
there is no container between a control ticket and the disk:

- `Page.navigate` and `Target.createTarget` to a `file:`, `chrome:`, `devtools:`,
  `chrome-extension:`, `view-source:` or `chrome-untrusted:` address.
- `Page.setDownloadBehavior` / `Browser.setDownloadBehavior` pointed anywhere
  outside that copy's own `downloads` directory. The Docker-era `/downloads`
  path is retargeted at the real directory rather than refused.

A refused command is answered with a CDP error object, so the caller settles
instead of hanging, and the first refusal on a connection is logged.

## Listeners

`VENEER_BROWSER_BIND` selects the address for both listeners (`127.0.0.1` on
macOS, `0.0.0.0` on Linux). On macOS a non-loopback bind is refused unless
`VENEER_BROWSER_ALLOW_REMOTE=1` is set as well — there is no VM boundary here,
so putting these profiles on the network has to be a decision rather than a typo.
When a TLS listener is configured, the plain HTTP listener stays on loopback
regardless, so tickets and bearer tokens never cross a network in cleartext.

## Encryption at rest

The store holds real logged-in profiles, so it should be encrypted at rest.

- macOS: the manager checks `fdesetup status` at boot. FileVault off is a loud
  warning, and `VENEER_BROWSER_REQUIRE_ENCRYPTED=1` turns it into a refusal to
  start.
- Linux: mount an encrypted LUKS volume at the store path;
  `VENEER_BROWSER_REQUIRE_ENCRYPTED=1` verifies it with `findmnt`/`lsblk`.

## Linux/Docker backend

Additional setup that only the container backend needs:

- Mount an encrypted LUKS volume at `/srv/veneer-browser/store`.
- Keep `/etc/veneer-browser/clients.json` root-only.
- Build `runtime/Dockerfile` as `veneer-browser-runtime:1`.
- Install Playwright's Chrome sandbox seccomp profile at
  `/etc/veneer-browser/seccomp_profile.json`.
- Bind port 7300 to a private or authenticated TLS ingress. Do not publish it as
  a raw browser URL.
- Chrome runs as UID 10001 in one container per active profile, with its sandbox
  enabled, and that copy's downloads directory mounted at `/downloads`.
