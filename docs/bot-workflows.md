# Bot workflows

Approved September 22, 2026; build 211. This specification covers all five approved Grok Bot-inspired features.

## Product behavior and acceptance criteria

1. **Bot routines and events.** A named bot owns each routine. Scheduled runs and authenticated OrderOps `ticket.created` / `customer.replied` events deliver to that bot's existing conversation through the durable wake dispatcher. Events are reference data, never approval. Stable event IDs deduplicate retries; busy bots queue work. Rules have explicit scope, enabled state, and delivery history. Disabling a rule cancels undelivered wakes. Check actor access again at delivery. Existing polling remains until an actual source is connected and verified; never silently enable duplicate production workers.
2. **Notifications.** A human explicitly subscribes their device and chooses each bot's input, blocked, and completion notifications. Web Push works with the app closed. Generic lock-screen copy opens the exact chat or decision. Quiet hours use an IANA timezone. Removed access and revoked devices stop delivery; expired subscriptions are deleted. Durable outbox retries transient errors without logging credentials or notification contents.
3. **Search.** A keyboard-accessible search dialog finds authorized conversation messages, decisions, and huddle messages, with dates, source labels and exact navigation. Search indexes only human/assistant text, never tool payloads or credential cards. Search authorization is applied at read time, including employee and business restrictions. Bounded pagination and clear indexing state prevent claims of exhaustive coverage while backfilling.
4. **Bot templates.** Duplicate or save a private template from a bot. Review name, role, scope, skills, and routines before creation. Copies get fresh conversation identities, no history, learned memory, credentials, browser assignments, delegation, or action grants. Routines start paused. Templates stay within their business and users need management authority to create bots. A template records configuration explicitly rather than following mutable source configuration silently.
5. **Teach a task.** From a bot's computer view, name the outcome and record up to ten minutes of browser interaction, without microphone, screenshots or typed values. Stop to review/edit the resulting skill draft, supply inputs, decision rules and validation, and save to the authorized project's skill library. Pause recording for sign-in. Credential entry never enters recording. Test against a second example with an explicit instruction before scheduling. The recorded path is evidence to generalize, not blind coordinate replay.

## Architecture

Additive SQLite migration; dedicated workflow modules and authenticated API routes. Reuse conversation access helpers, durable conversation wakeups, skill storage, existing browser viewer and chat navigation. Browser recording stays behind the manager's short-lived control ticket boundary. Push keys stay in the existing private secret store. Private browser UI and business roles retain their existing boundaries.

## Validation and deployment

Test cross-business access/revocation, duplicate event delivery and pending cancellation, quiet hours and stale subscriptions, template exclusion of authority/history, and teaching redaction/timeout. Run root typecheck, all tests, build, then restart. Commit explicit changed paths and push main. Verify live health and new routes without sending customer messages or performing financial actions.

## Reference behavior

- [Skills, teaching and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Notifications](https://docs.x.ai/grok-bot/settings-and-notifications)
- [Search and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Duplication and templates](https://docs.x.ai/grok-bot/bots)

Grok Bot documents gradual rollout for teaching, mobile push and some search surfaces. Veneer's implementation uses its existing single-Mac architecture and PWA.

## OrderOps sender contract

Endpoint: `POST /webhooks/bot-events/<source-id>`, outside the human API router, authenticated with a source-specific HMAC. The proxy must allow this signed endpoint through; it must not redirect it to an interactive login. No unauthenticated event is accepted.

Headers: `X-Veneer-Timestamp` is Unix seconds. `X-Veneer-Signature` is hexadecimal HMAC-SHA256 over `timestamp + '.' + exact JSON body`. Timestamps have a five-minute window. Obtain the source key from the private server secret store at use time and provision it directly into the sender's secret manager; never include it in a transcript, database row, CLI argument, or report.

Body fields:

| Field | Meaning |
| --- | --- |
| `id` | Durable unique source event ID; reuse unchanged on retries. |
| `type` | `ticket.created`, `customer.replied`, or `connection.test`. |
| `ticket_id` | Source ticket identifier; `connection-test` for a connection probe. |
| `occurred_at` | ISO timestamp from the source transaction. |
| `assigned_bot` | Veneer conversation UUID of the responsible bot. Required for customer replies. |

Do not send customer message text, email addresses, credentials, or instructions. Bots fetch current authorized evidence from the ticket system. `connection.test` verifies transport without creating a bot wake. The response `{ok:true,queued:n}` acknowledges receipt; a duplicate returns zero queued. Non-2xx means retry from the sender's durable outbox. Distinct events get distinct pending wakes even when their bot is busy.

OrderOps integration must create an outbox row in the same transaction as ticket creation or the inbound customer reply. Its dispatcher uses [bot-event-sender.mjs](/Users/archerclawdington/veneer-os/scripts/bot-event-sender.mjs), with retry/backoff and a stable event ID. Resolve the responsible registered Veneer bot before sending customer replies. Do not replace Avery's or Grant's current polling until a signed probe and an end-to-end event receipt have been verified and overlapping workers are reconciled.

## Build 211 validation

- Root typecheck and production build passed.
- Full test suite: 2,160 server tests passed (5 skipped), 848 web tests, 40 browser-manager tests, and 21 installer tests passed.
- Three event-sender tests passed separately.
- Isolated desktop/mobile browser checks covered routine creation, enable/pause, template duplication, teaching start/stop/edit/save/test, search, and notification controls. The mobile dialog was checked for horizontal overflow.
- A real browser DOM probe confirmed typed values are excluded and password forms are rejected by the recorder.
- No production customer actions, live routine activation, device subscription, or browser account changes were used for validation.

Push delivery to the owner's actual phone still requires enabling notifications on that device. OrderOps event ingestion is implemented and tested, but its source application must install and configure the durable sender before live tickets can wake bots. Existing intake polling remains active until that cutover is verified. The separate OrderOps queue/delegation question is pending in the originating chat.

## Changed files

- [docs/bot-workflows.md](/Users/archerclawdington/veneer-os/docs/bot-workflows.md)
- [package-lock.json](/Users/archerclawdington/veneer-os/package-lock.json)
- [scripts/bot-event-sender.mjs](/Users/archerclawdington/veneer-os/scripts/bot-event-sender.mjs)
- [scripts/bot-event-sender.test.mjs](/Users/archerclawdington/veneer-os/scripts/bot-event-sender.test.mjs)
- [server/package.json](/Users/archerclawdington/veneer-os/server/package.json)
- [server/src/botWorkflows/background.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/background.ts)
- [server/src/botWorkflows/notifications.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/notifications.ts)
- [server/src/botWorkflows/routes.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/routes.ts)
- [server/src/botWorkflows/routines.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/routines.ts)
- [server/src/botWorkflows/search.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/search.ts)
- [server/src/botWorkflows/teaching.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/teaching.ts)
- [server/src/botWorkflows/templates.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/templates.ts)
- [server/src/bots/delivery.ts](/Users/archerclawdington/veneer-os/server/src/bots/delivery.ts)
- [server/src/bots/employeeAccess.ts](/Users/archerclawdington/veneer-os/server/src/bots/employeeAccess.ts)
- [server/src/channels/cdpDesktop.ts](/Users/archerclawdington/veneer-os/server/src/channels/cdpDesktop.ts)
- [server/src/channels/veneerBrowser.ts](/Users/archerclawdington/veneer-os/server/src/channels/veneerBrowser.ts)
- [server/src/db/migrations/0103_bot_workflows.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0103_bot_workflows.sql)
- [server/src/index.ts](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/src/routes/api.ts](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [server/test/botWorkflowRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/botWorkflowRoutes.test.ts)
- [server/test/botWorkflows.test.ts](/Users/archerclawdington/veneer-os/server/test/botWorkflows.test.ts)
- [web/public/sw.js](/Users/archerclawdington/veneer-os/web/public/sw.js)
- [web/src/components/BotActions.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotActions.tsx)
- [web/src/components/BotWorkflows.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotWorkflows.tsx)
- [web/src/components/NavBar.tsx](/Users/archerclawdington/veneer-os/web/src/components/NavBar.tsx)
- [web/src/components/browser/ConversationBrowserPanel.tsx](/Users/archerclawdington/veneer-os/web/src/components/browser/ConversationBrowserPanel.tsx)
- [web/src/lib/workspaceSearch.test.ts](/Users/archerclawdington/veneer-os/web/src/lib/workspaceSearch.test.ts)
- [web/src/lib/workspaceSearch.ts](/Users/archerclawdington/veneer-os/web/src/lib/workspaceSearch.ts)
- [web/src/main.tsx](/Users/archerclawdington/veneer-os/web/src/main.tsx)
- [web/src/screens/Chat.tsx](/Users/archerclawdington/veneer-os/web/src/screens/Chat.tsx)
- [web/src/screens/Huddles.tsx](/Users/archerclawdington/veneer-os/web/src/screens/Huddles.tsx)
