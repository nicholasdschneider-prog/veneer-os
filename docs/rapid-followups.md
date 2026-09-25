# Rapid human follow-ups — September 25, 2026

Ordinary human messages now use the server's current turn state to decide delivery, even when the browser still shows idle. Explicit Queue requests keep their original semantics. Agent coordination stays on its existing isolated delivery path.

A follow-up arriving during memory/toolbox preparation waits for the current provider handle. Codex follow-ups arriving before thread/start or turn/start completes wait for that exact native turn, then issue turn/steer once. If startup ends or the provider rejects steering, the original durable fallback remains available. Different-sender, unsupported-provider, compaction, failure, and approval boundaries remain intact.

The browser displays ordinary pending sends as Sending, rather than guessing they are queued from its cached status. A durable WebSocket receipt that arrives before the HTTP response replaces the matching optimistic bubble for display. Matching is bounded to queue rows newer than the send and consumes each display match once, so identical rapid messages retain their count. This presentation reconciliation does not remove or execute messages.

## Verification

Root typecheck, the full test suite, and the production build passed: 2,529 server tests (five skipped), 906 web tests, 40 browser-manager tests, and 29 installer tests.

- Delayed native Codex startup integration: a result reply starts the real runtime and Codex adapter against an isolated app-server fixture; an immediate ordinary follow-up reaches the same native turn exactly once. There is one turn/start, one turn/steer, no interrupt, and no leftover queued message.
- Adapter tests cover two follow-ups arriving before the native ID exists, arrival order, and stopping before readiness.
- Runtime tests hold memory preparation open and verify two durable follow-ups enter the same turn in order. Existing sender, provider, failed-turn, compaction, stop, and restart regression tests remain passing.
- API tests exercise /messages from a stale-idle browser, explicit queue requests, archived-chat reactivation, and private/team access.
- Full application browser fixtures pass at 390px and 1440px: two actual composer sends while idle and HTTP responses held open, no Queue/Send now controls, and one bubble per message when WebSocket receipts precede HTTP responses. These are synthetic records; no real employee or customer messages were sent.
- The employee guide and resumed-agent instructions include startup handling. Guide browser checks cover full/restricted access, desktop/mobile, discovery, refresh, and aging.

The [employee guide](/#/bot-guide?feature=steer-working-bot) documents the behavior and remaining queue fallbacks.

## Changed files

- [scripts/result-replies-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/result-replies-browser-check.mjs)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/providers/codexAppServer/adapter.ts](/Users/archerclawdington/veneer-os/server/src/providers/codexAppServer/adapter.ts)
- [server/src/routes/api.ts](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [server/src/runtime/conversationManager.ts](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [server/test/bots.test.ts](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)
- [server/test/codexAppServer.test.ts](/Users/archerclawdington/veneer-os/server/test/codexAppServer.test.ts)
- [server/test/conversationReactivation.test.ts](/Users/archerclawdington/veneer-os/server/test/conversationReactivation.test.ts)
- [server/test/coordination.test.ts](/Users/archerclawdington/veneer-os/server/test/coordination.test.ts)
- [server/test/fixtures/fake-app-server.mjs](/Users/archerclawdington/veneer-os/server/test/fixtures/fake-app-server.mjs)
- [server/test/instructionContext.test.ts](/Users/archerclawdington/veneer-os/server/test/instructionContext.test.ts)
- [server/test/restart.test.ts](/Users/archerclawdington/veneer-os/server/test/restart.test.ts)
- [server/test/turnResume.test.ts](/Users/archerclawdington/veneer-os/server/test/turnResume.test.ts)
- [web/src/lib/api.ts](/Users/archerclawdington/veneer-os/web/src/lib/api.ts)
- [web/src/lib/queueSnapshots.test.ts](/Users/archerclawdington/veneer-os/web/src/lib/queueSnapshots.test.ts)
- [web/src/lib/queueSnapshots.ts](/Users/archerclawdington/veneer-os/web/src/lib/queueSnapshots.ts)
- [web/src/screens/Chat.tsx](/Users/archerclawdington/veneer-os/web/src/screens/Chat.tsx)
