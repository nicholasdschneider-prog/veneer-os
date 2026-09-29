# General bot questions — September 29, 2026

Build #466 makes decision cards lead with **What the bot needs from you**, using a supplied plain-language request or the unchanged original question. New summaries can omit customer and refund fields. Bot tool descriptions and the shared feature guide teach operational, internal and customer service requests on the same surface. Voice summaries also expose the request.

Older summaries retain their supplied context. Without a customer reply or a new request field, that context uses a neutral label and a forced legacy unknown-refund value is not promoted into a refund concern. Sourced refund history remains visible. An absent refund section never certifies that no refund occurred. Exact proposals, versions, approvals, delivery payloads and execution guards are unchanged; no live decisions were edited.

## Validation

- Root typecheck passed.
- Full root test suite passed: 3,077 server tests (five skipped), 919 web tests, 49 browser-manager tests and 29 installer tests.
- Isolated decision browser checks passed at 320, 375, 414, 768 and 1,440 pixels in light and dark themes, including operational requests, legacy context, customer replies, refund evidence, keyboard/tap/hover disclosure and overflow.
- Isolated guide checks passed for full and restricted employees, desktop/mobile access, feature search and example copying, new announcements, refresh, aging and error recovery. A stale assertion for the separately released routine-label feature was updated to its current published limits before rerunning successfully.
- Catalog tests verify the new instructions reach fresh/resumed bots under full and restricted instruction contexts.

## Deployment

The production build passed after correcting TypeScript casts in three synthetic test fixtures; root typecheck and the affected 11 component tests passed again. The build emitted its existing bundle-size advisory. The root restart completed successfully: web, runner, app-runner, terminal and browser manager reported healthy. Local web/runner checks passed; the public front door returned HTTP 302 and the tunnel reported four active edge connections. These health checks do not certify authenticated end-to-end chat delivery.

## Changed files

- [server/src/bots/service.ts](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/src/voice/workspace.ts](/Users/archerclawdington/veneer-os/server/src/voice/workspace.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [web/src/lib/bots.ts](/Users/archerclawdington/veneer-os/web/src/lib/bots.ts)
- [web/src/components/BotProposalSummary.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotProposalSummary.tsx)
- [web/src/components/BotProposalSummary.test.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotProposalSummary.test.tsx)
- [server/test/decisionReviewSummary.test.ts](/Users/archerclawdington/veneer-os/server/test/decisionReviewSummary.test.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [scripts/fixtures/decision-review.tsx](/Users/archerclawdington/veneer-os/scripts/fixtures/decision-review.tsx)
- [scripts/decision-review-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/decision-review-browser-check.mjs)
- [scripts/bot-guide-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
