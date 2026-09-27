# Browser capacity repair — September 27, 2026

Implemented and deployed in commit `682bbbf`, pushed to origin main.

The installation had five active working copies, all from ERVP, blocking other
projects. Open automation connections prevented the old idle cleanup from reclaiming
slots. The application now uses command history and pending-turn state to suspend
eligible completed read-only copies after 30 idle minutes. Their files remain for
reopening. Admission is serialized across projects and warm adoption respects the
same global limit. Saved profiles and account assignments are unchanged.

Protected sessions include active turns, explicit sign-in sessions, human-viewed
copies, capture, secret fields, and interaction or unknown histories. Those sessions
require their owner to finish the workflow and explicitly stop the browser. Public
read-only browsing without a saved profile can also release idle slots. Bots receive
the updated completion instructions on subsequent turns through the living guide.

## Validation

Typecheck, full tests, and production build passed before restart: 2,541 server tests
passed (5 skipped), 907 web tests, 42 browser-manager tests, and 29 installer tests.
Tests cover concurrent admission, warm-copy limits, protected sessions, uncertain
mutations, retained copies, and resume. Guide tests cover employee access and current
instructions delivered to resumed agents.

Restarting the runner interrupted this chat after the web and runner replacements.
The remaining app-runner, terminal, and browser-manager services were then restarted
through the supported npm restart command. All five local health endpoints returned
200. Tunnel/public-front-door checks passed their connectivity checks; they do not
prove authenticated end-to-end chat delivery.

At 16:01:29 UTC, Piper Content automatically suspended and recorded
`clone.idle_suspended`. Its local copy record remained. The other four protected
sessions remained active. This Veneer project then successfully opened its Default
profile in the freed slot through the normal browser tool. The temporary verification
copy was explicitly stopped and deleted afterward, leaving the saved profile unchanged.
AutoShip was human-viewed during deployment and was correctly protected.

## Capacity recommendation

Keep five active sessions on the 16 GB Mac for now. More saved profiles should reflect
separate authorized account identities, not be used as a capacity workaround. Native
visible Chrome remains configured; headless browsers still consume memory and slots.
Use authorized connectors for structured tasks where appropriate. Stop finished
protected workflows after retaining downloads and intentionally saving new logins.

This is bounded idle reclamation, not unlimited concurrency or a durable fair browser
waiting queue. All five slots can still be legitimately occupied. Retained suspended
copies consume disk until explicitly stopped or removed through normal owner cleanup.
Old element references and unsaved page state are not guaranteed after reopening.

## Changed files

- [browser-manager/INSTALL-MACOS.md](/Users/archerclawdington/veneer-os/browser-manager/INSTALL-MACOS.md)
- [browser-manager/README.md](/Users/archerclawdington/veneer-os/browser-manager/README.md)
- [browser-manager/manager.mjs](/Users/archerclawdington/veneer-os/browser-manager/manager.mjs)
- [browser-manager/manager.test.mjs](/Users/archerclawdington/veneer-os/browser-manager/manager.test.mjs)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/routes/veneerBrowser.ts](/Users/archerclawdington/veneer-os/server/src/routes/veneerBrowser.ts)
- [server/src/veneerBrowser/manager.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/manager.ts)
- [server/src/veneerBrowser/mcp.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/mcp.ts)
- [server/src/veneerBrowser/remoteClient.ts](/Users/archerclawdington/veneer-os/server/src/veneerBrowser/remoteClient.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [server/test/veneerBrowser.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowser.test.ts)
- [server/test/veneerBrowserMcp.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserMcp.test.ts)
- [server/test/veneerBrowserRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/veneerBrowserRoutes.test.ts)
