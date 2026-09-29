# Browser research and capacity continuations — September 29, 2026

Build #457 follows the incomplete #386 and #427 capacity repairs. At investigation,
Plaud, Grant, Sage, Clara, and Henry occupied all five Chrome slots. Fin research
chat `8850b454-59f0-4653-8292-26996df4c4f9` completed its written report but could not
complete video review: browser capacity was unavailable and public captions were
separately unavailable. Neither earlier repair established reliable research access
under saturation.

## Result and limits

Public HTML/plain-text research now has a `read_public` tool and authenticated
runner operation that never needs Chrome, cookies, or a signed-in profile. It
validates and pins public DNS addresses for each connection and redirect, refuses
private/local addresses and credential URLs, and strips scripts/forms from HTML
extraction. It allows four concurrent HTTP requests with 30-second maximum deadlines,
2 MiB response limits, and bounded output. It does not render JavaScript, watch
videos, recover missing captions, or silently fall back to another identity.
No extra Chrome pool or higher runtime limit was added.

Capacity-blocked bot Open calls automatically save a one-hour same-chat continuation.
Explicit `wait_for_capacity` can retain exact task context for up to two hours.
SQLite retains up to 32 pending waits; eligible chats are admitted in arrival order,
one per maintenance tick, with an opportunity before foreground cold allocation.
Busy requesting chats wait until their turn ends. Allocation uses the existing
atomic global five-slot gate, including warm adoption. The durable queue never
stores or replays navigation, clicks, or business mutations.

After allocation, one idempotently delivered platform wake tells the original chat
to inspect current state and continue under its original authority. Expiration
produces one blocker wake; an uncertain allocation produces one reconciliation
wake. Restart recovery inspects an already-known active working copy and never
blindly repeats an interrupted allocation. Changes to owner, project, profile,
provider session, or newer human input invalidate old waits, including a recheck
at wake dispatch. Cancellation suppresses undelivered wakes, but does not kill an
already allocated copy. The panel exposes the wait deadline and Cancel wait.
An automatic wait is not recreated endlessly for the same unchanged task context.

## Idle protection findings

The previous checker mistook a checkbox's normal value `on` versus empty default
value for an unsaved edit. It now checks the checked state instead. It also allows
an unchanged explicit search control whose query is already preserved in the URL.
Password inputs and ordinary hydrated forms do not receive that exemption. Real
changed checkbox/search states, drafts, page exit handlers, active turns/commands,
viewers, capture, sign-in, explicit Keep open, and uncertain outcomes remain protected.

Read-only inspection of the five live copies still found protection signals after
those narrow corrections. In particular, page exit handlers and other form state
remain. We did not invoke exit handlers, clear fields, navigate protected pages,
or claim that no pending turn proves business completion. The public research path
is deliberately independent of those signed-in sessions. Interactive rendering can
still wait or expire if every browser is protected; this is bounded capacity, not
unlimited concurrency. More saved profiles are not a runtime-capacity solution.

## Validation

Focused tests cover public reads beyond five sequential projects; SSRF, mixed DNS,
DNS pinning, redirects, deadlines and bounded concurrency; durable FIFO waits,
idempotency, cancellation, expiration, owner/profile drift, active turns, restart
reconciliation, and dispatch through the existing wake scheduler. Real isolated
Chrome tests exercise baseline checkbox/search controls versus actual edited state,
ordinary hydrated forms, shadow-root editors and beforeunload protection. Guide
tests cover employee access and resumed-agent instruction delivery.

Typecheck passed. The full suite passed with 3,025 server tests (5 skipped),
910 web tests, 54 browser-manager tests, and 29 installer tests. Final cancellation
race coverage added two more passing tests; the complete 13-test capacity-wait
suite and 134-test browser-manager application suite passed after those changes.
Production build passed. Source commit `4b983d3` was pushed to origin main.

## Deployed acceptance

The supported restart script reported healthy replacements for web, app-runner,
terminal, and browser-manager. Restarting the runner interrupted this turn; a
follow-up verified the replacement runner (PID 52434) and healthy local web/runner
checks. The public front door returned HTTP 302 and the tunnel reported four active
edge connections; those are connectivity checks, not authenticated public-chat
acceptance. Migration 0135 was present in the live database.

At 12:40:24 UTC, through the deployed authenticated runner operation for the original
Fin research chat (after verifying its owner matches this requesting owner), both
reads succeeded with occupancy **5/5 before and after**:

- [Fin Procedures explained](https://www.intercom.com/help/en/articles/12495167-fin-procedures-explained): 10,001 characters of public text.
- [How Fin Scales Customer-Defined Behaviour](https://fin.ai/research/how-fin-scales-customer-defined-behaviour/): 13,840 characters of public text.

Both results explicitly returned `mode=public_http`, `rendered=false`. Fin had no
active browser before or after; no browser slot was needed or created. This proves
the saturated public-documentation research path, not full video/transcript review.

A normal bot Open in this requesting chat then waited about 20 seconds at capacity
and returned a saved durable continuation, not a terminal HTTP500. Verification
wait `3391da49-6574-4fa6-a97f-df7124d317c8` was canceled immediately through the scoped
Cancel tool. Readback confirmed `status=cancelled`, `wakeup_id=null`, no working copy
in either the requesting or Fin chat, and exactly five native runtime records.
There is no leftover verification slot or scheduled test continuation. Actual
ready/expired wake delivery and restart recovery were verified in isolated tests;
no protected live copy was forced closed to stage a successful live admission.

The five protected existing copies remain. Browser-only work can still wait or
expire while all are protected. Missing public captions, JavaScript-only pages and
video review are separate limitations; this release does not claim to solve those
by reading metadata. Signed-in profile identities and working files were preserved.

## Changed files

- [browser-manager/INSTALL-MACOS.md](/Users/archerclawdington/veneer-os/browser-manager/INSTALL-MACOS.md)
- [browser-manager/README.md](/Users/archerclawdington/veneer-os/browser-manager/README.md)
- [browser-manager/idle-safety-chrome.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/idle-safety-chrome.test.mjs)
- [browser-manager/idle-safety.mjs](/Users/archerclawdington/veneer-os/browser-manager/idle-safety.mjs)
- [package-lock.json](/Users/archerclawdington/veneer-os/package-lock.json)
- [server/package.json](/Users/archerclawdington/veneer-os/server/package.json)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/routes/veneerBrowser.ts](/Users/archerclawdington/veneer-os/server/src/routes/veneerBrowser.ts)
- [server/src/runner/client.ts](/Users/archerclawdington/veneer-os/server/src/runner/client.ts)
- [server/src/runner/ipcServer.ts](/Users/archerclawdington/veneer-os/server/src/runner/ipcServer.ts)
- [server/src/scheduled/wakeups.ts](/Users/archerclawdington/veneer-os/server/src/scheduled/wakeups.ts)
- [server/src/veneerBrowser/manager.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/manager.ts)
- [server/src/veneerBrowser/mcp.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/mcp.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [server/test/veneerBrowserMcp.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserMcp.test.ts)
- [web/src/components/browser/ConversationBrowserPanel.test.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/ConversationBrowserPanel.test.tsx)
- [web/src/components/browser/ConversationBrowserPanel.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/ConversationBrowserPanel.tsx)
- [web/src/lib/types.ts](/Users/archerclawdington/veneer-os/web/src/lib/types.ts)
- [server/src/db/migrations/0135_browser_capacity_waits.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0135_browser_capacity_waits.sql)
- [server/src/veneerBrowser/capacityWait.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/capacityWait.ts)
- [server/src/veneerBrowser/publicReader.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/publicReader.ts)
- [server/test/browserCapacityWait.test.ts](/Users/archerclawdington/veneer-os/server/test/browserCapacityWait.test.ts)
- [server/test/publicReaderTransport.test.ts](/Users/archerclawdington/veneer-os/server/test/publicReaderTransport.test.ts)
- [server/test/veneerBrowserPublicReader.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserPublicReader.test.ts)
