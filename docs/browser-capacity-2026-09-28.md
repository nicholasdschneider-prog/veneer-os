# Recurring browser capacity repair — September 28, 2026

Build #427 corrects an incomplete repair in #386. The earlier change successfully
suspended some read-only copies, but old human viewing and interaction histories
could protect other copies for their entire lifetime. Adding saved profiles does
not add runtime capacity. The default remains five active copies on this 16 GB Mac.

At the initial investigation five runtime slots were occupied. A later read-only
check established that Owen automatically suspended at 20:29 UTC under the old
code, so its earlier presence does not establish a permanently failed cleanup.
Four other idle copies remained: Plaud, Grant, Sage, and Clara. No pending turns
were present for those owners at the pre-deployment check. This is evidence of
turn inactivity, not proof their business workflows were complete.

## Changes

Idle suspension still requires 30 minutes without application command activity.
Active turns/commands, current viewers and their 30-minute grace period, fresh
sign-in sessions, secret fields, capture, explicit Keep open, and uncertain command
outcomes remain protected. Successful old interactions and a lifetime human-viewed
flag no longer permanently occupy slots.

Before suspension the manager checks current Chrome pages and frames for filled
forms, editable text, dialogs, and page exit warnings. Failed inspection blocks
suspension. Activity is checked again before disconnecting stale automation
transports and stopping Chrome. Working-copy files, downloads, and saved profile
bases remain. This is resource suspension, not business completion or proof an
external action succeeded. Arbitrary in-memory application state cannot be
perfectly inferred; use Keep open for unfinished workflows.

Opening uses a bounded FIFO allocation queue (up to 20 seconds, maximum 32 waiting
requests), with global atomic admission including warm adoption. It never retries
browser mutations or uncertain allocation errors. A full queue returns a readable
capacity response (HTTP 429), not a runner HTTP 500. Expired requests cannot launch
later. This is not a durable job queue: after timeout, the bot must retain its task
context and retry opening when capacity is available; no business action is replayed.

The browser panel shows slot counts and only the occupying chats that the caller
is authorized to access. Current protection/cleanup reasons are retained in audit
records and displayed without page contents. Keep open is available in the panel
and as a scoped bot tool. Releasing it permits normal safety checks; it does not
clear uncertain outcomes. Dead viewer connections use ping/pong expiry.

## Recovery and operating guidance

Finish or preserve an unfinished workflow before releasing Keep open. Intentionally
save new logins and retain required downloads before using the existing Stop action,
which removes the temporary copy. Do not stop another bot's work to free capacity.
After automatic suspension, reopen the same retained copy, list tabs, select the
intended page, and take a fresh snapshot; old references must not be replayed.

Five genuinely active or protected sessions can still occupy every slot. Headless
Chrome still uses memory and capacity. More profiles are appropriate for separate
authorized account identities, not as a scaling workaround. Larger concurrency
needs measured memory capacity and a separate durable scheduling design.

## Validation and deployment

Typecheck and the full test suite passed: 2,683 server tests (5 skipped), 909 web
tests, 54 browser-manager tests, and 29 installer tests. Coverage includes
cross-project admission, FIFO waiting/cancellation, warm limits, viewer expiry,
protected workflows, uncertain effects, retained working copies, owner visibility,
and employee/resumed-agent guide delivery. A real isolated Chrome test verified
filled forms, hydrated values, shadow-root editors, and beforeunload detection.
Production build and live deployment verification are recorded below when complete.

## Changed files

- [browser-manager/INSTALL-MACOS.md](/Users/archerclawdington/veneer-os/browser-manager/INSTALL-MACOS.md)
- [browser-manager/README.md](/Users/archerclawdington/veneer-os/browser-manager/README.md)
- [browser-manager/manager.mjs](/Users/archerclawdington/veneer-os/browser-manager/manager.mjs)
- [browser-manager/manager.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/manager.test.mjs)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/routes/veneerBrowser.ts](/Users/archerclawdington/veneer-os/server/src/routes/veneerBrowser.ts)
- [server/src/runner/client.ts](/Users/archerclawdington/veneer-os/server/src/runner/client.ts)
- [server/src/runner/ipcServer.ts](/Users/archerclawdington/veneer-os/server/src/runner/ipcServer.ts)
- [server/src/veneerBrowser/manager.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/manager.ts)
- [server/src/veneerBrowser/mcp.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/mcp.ts)
- [server/src/veneerBrowser/remoteClient.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/remoteClient.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [server/test/veneerBrowser.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowser.test.ts)
- [server/test/veneerBrowserMcp.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserMcp.test.ts)
- [server/test/veneerBrowserRemote.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserRemote.test.ts)
- [server/test/veneerBrowserRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserRoutes.test.ts)
- [web/src/components/browser/BrowserStartingState.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/BrowserStartingState.tsx)
- [web/src/components/browser/ConversationBrowserPanel.test.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/ConversationBrowserPanel.test.tsx)
- [web/src/components/browser/ConversationBrowserPanel.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/ConversationBrowserPanel.tsx)
- [web/src/lib/types.ts](/Users/archerclawdington/veneer-os/web/src/lib/types.ts)
- [browser-manager/admission.mjs](/Users/archerclawdington/veneer-os/browser-manager/admission.mjs)
- [browser-manager/admission.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/admission.test.mjs)
- [browser-manager/idle-safety.mjs](/Users/archerclawdington/veneer-os/browser-manager/idle-safety.mjs)
- [browser-manager/idle-safety.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/idle-safety.test.mjs)
- [browser-manager/idle-safety-chrome.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/idle-safety-chrome.test.mjs)
