# Human result replies — September 25, 2026

Replies to completed bot results now use the existing live-steering behavior for human follow-ups. A reply carries the actual human text, a bounded original-result quotation, and its thread reference. Consecutive replies reach a supported active provider without stopping its work. Idle bots start normally. Providers without live steering, failed writes, or a different active sender retain the same durable reply for a later turn.

The reply feed remains the canonical visible message, including the original-result reference. Typed delivery provenance suppresses the duplicate transport prompt in the queued, steering, and historical transcript views. Authenticated old result-notification wrappers are also hidden; ordinary human messages and unrelated scheduled reminders remain visible. Already-delivered reminders are not replayed.

Delivery uses the existing durable wake receipt and queue, with the real human sender identity. Retrying a delivery never sends another copy or dismisses a newer question. The fallback rechecks current access before execution, including after restart. Thread replies do not record decision approval, grant account access, or bypass existing provider/sender guards.

## Verification

- Root typecheck and production build passed.
- Restart completed through the root npm script. Web, runner, app-runner, terminal, and browser-manager services restarted successfully; local web/runner health passed and the public front door returned its expected authentication redirect. No authenticated production-message test was sent.
- Full suite passed: 2,525 server tests (five skipped), 905 web tests, 40 browser-manager tests, and 29 installer tests. The final route-text and resumed-instruction assertions also passed their focused tests.
- Regression coverage includes three rapid replies, one-time acknowledgment, unsupported-provider/write-failure/different-sender fallback, access revocation, idle start, restart recovery, and ordinary wakeups remaining outside live steering.
- Isolated full-application browser checks passed at 390px and 1440px: each actual reply appears once while queued, during steering, and after provider consumption; internal reminder and tool instructions do not appear.
- Guide browser checks passed for full/restricted employees, desktop/mobile, search, release notices, refresh, and access. The resumed-instruction regression verifies the new guidance arrives without changing frozen role snapshots.
- No real employee messages or customer actions were used as tests.

Employee instructions and the dated announcement are in [Discuss an individual result](/#/bot-guide?feature=result-threads).

## Implementation files

- [scripts/bot-guide-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
- [scripts/result-replies-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/result-replies-browser-check.mjs)
- [server/src/bots/communication.ts](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [server/src/bots/communicationRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/runner/ipcServer.ts](/Users/archerclawdington/veneer-os/server/src/runner/ipcServer.ts)
- [server/src/runtime/conversationManager.ts](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [server/src/runtime/events.ts](/Users/archerclawdington/veneer-os/server/src/runtime/events.ts)
- [server/test/botCommunication.test.ts](/Users/archerclawdington/veneer-os/server/test/botCommunication.test.ts)
- [server/test/bots.test.ts](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)
- [server/test/instructionContext.test.ts](/Users/archerclawdington/veneer-os/server/test/instructionContext.test.ts)
- [web/src/lib/threadReplies.test.ts](/Users/archerclawdington/veneer-os/web/src/lib/threadReplies.test.ts)
- [web/src/lib/threadReplies.ts](/Users/archerclawdington/veneer-os/web/src/lib/threadReplies.ts)
- [web/src/lib/transcript.test.ts](/Users/archerclawdington/veneer-os/web/src/lib/transcript.test.ts)
- [web/src/lib/transcript.ts](/Users/archerclawdington/veneer-os/web/src/lib/transcript.ts)
- [web/src/lib/types.ts](/Users/archerclawdington/veneer-os/web/src/lib/types.ts)
- [web/src/screens/Chat.tsx](/Users/archerclawdington/veneer-os/web/src/screens/Chat.tsx)
