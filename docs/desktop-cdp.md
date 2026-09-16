# The VM Desktop (CDP mode)

`VP_DESKTOP_MODE=cdp` streams the shared Chrome over the DevTools protocol: the
server runs `Page.startScreencast` and forwards JPEG frames to a canvas viewer,
and replays the viewer's mouse and keyboard with `Input.dispatch*`.

It replaces the VNC stack — Xvfb, openbox, x11vnc, noVNC — and with it the need
for a display server. That is what lets the desktop work on macOS at all: there
is no login session to hold, and no Screen Recording or Accessibility permission
to grant.

`VP_DESKTOP_MODE=vnc` remains a compatibility fallback for old manual installs.
macOS installs use `cdp`.

## What works

- Watching and driving the shared browser: mouse, wheel, keyboard, typing
- Multiple tabs, with a switcher; popups are followed automatically
- Viewport sized to the viewer's window
- File **upload**: the page's picker is intercepted, the viewer chooses a local
  file, and the bytes are handed to the page's input (`DOM.setFileInputFiles`)
- File **download**: lands in `DATA_DIR/desktop-downloads`, no dialog
- Clipboard **paste** into the page (replayed as key events); **copy** works
  through the page's own selection and Cmd/Ctrl-C
- Reconnect after a dropped socket; a slow viewer is throttled, not disconnected
- Agent `agent-browser` commands and a human viewer at the same time
- Chrome dying: the viewer is told, the service survives, and both reconnect
  once the supervisor restarts Chrome

## Intentionally not supported

These are properties of driving a browser over CDP, not defects, and no amount
of work on the viewer changes them. They were all available under VNC, because
VNC streamed a whole desktop rather than a browser.

- **Passkeys / WebAuthn.** The authenticator is the physical machine's, and the
  prompt is OS chrome. Use a password plus a TOTP code instead.
- **Touch ID and any biometric prompt.** Same reason.
- **Keychain / credential-manager prompts**, including "save this password".
- **Native OS dialogs of any kind** — print dialogs, "open with", permission
  sheets, certificate pickers. Chrome renders these outside the page, so they
  are not in the screencast and cannot be clicked. Downloads and file pickers
  are handled above precisely because they would otherwise fall into this hole.
- **Anything outside the browser.** There is no desktop, no Finder, no terminal
  — only the pages in the shared Chrome. The VNC mode showed a whole X session;
  this shows a browser.
- **Audio.** Frames are video only.

If a site's login genuinely requires a passkey or a native prompt, it cannot be
completed through the desktop viewer. Do that sign-in on a real machine and let
the browser profile carry the session.

## Not yet verified

- **A full OAuth + 2FA sign-in end to end.** The mechanics it depends on are all
  covered (typing, navigation, popups, redirects, cookies, tab switching), but
  no real provider login has been driven through this viewer, because that needs
  real credentials. Treat the first one as a test.

## Operating notes

- Chrome must expose the DevTools port on loopback (`VP_DESKTOP_CDP_PORT`,
  default 9223) — the same browser `agent-browser` drives via `--cdp`.
- macOS installs run it through the `com.veneer.chrome` launchd agent. The
  idempotent installer repairs the pinned Agent Browser CLI, managed Chrome,
  and its trusted config on every run.
- The boot probe (`scripts/boot-probe.mjs`) checks both the Agent Browser
  installation and the loopback CDP endpoint.
- Chrome renders only the foreground tab, so attaching to a tab calls
  `Page.bringToFront`. Without it a background tab produces no frames and
  `Page.captureScreenshot` never returns.
- Backpressure is ack pacing: Chrome sends the next frame only once the previous
  is acked, so a slow viewer receives fewer frames rather than a growing queue.
- Frames and keystrokes are the user's screen and typing. They are never logged.
- Uploaded files are held under `DATA_DIR/desktop-uploads` only long enough for
  the page to submit them, then deleted.
