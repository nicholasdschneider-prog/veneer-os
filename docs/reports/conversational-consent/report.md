# Conversational native consent — September 28, 2026

Build #402 extends existing native decisions. The original case-owning bot can record an authenticated human answer from a result reply or a newly submitted direct chat message, without another click or login. This does not execute an order, send a customer message, create financial authority, or implement an external OrderOps override.

## Contract

1. The owner calls `inspect_conversational_decision` with `decision_id`, `expected_version`, `source_kind` (`result_reply` or `direct_message`). Omit `source_id` only for bounded discovery, then inspect the exact returned ID.
2. Read the whole human source, original result and replies, current conversation, exact proposal, and native discussion. Resolve semantic intent; quoted words, bot statements, conditions, ambiguous discussion and changed scope are not consent. The inspection hash is a consistency check, not an external authorization credential.
3. For a clear unconditional answer to that unchanged scope, call `record_conversational_decision` with the exact source, version, inspection hash, action and `reviewed_full_context: true`. The server derives the human identity from authenticated provenance, checks current approver/evidence access and original owner, and atomically records the native answer, immutable receipt and durable answer wake.
4. After an uncertain recording response, inspect the same source read-only and check `recorded`. Do not replay external effects. Identical record retries cannot create a second answer/wake; conflicting source reuse is refused.
5. Follow the existing native lifecycle and fresh source checks. Approval is not completion. Current executor, duplicate, financial and external permission gates remain unchanged.

Direct provenance begins with this release; old transcript IDs cannot be imported. Result replies require an independently retained unchanged proposal predating the human instruction. Same-second historical events are refused when timestamp precision cannot prove ordering. Newer human context, changed version/handling, revoked author access and another owner are refused. Complete result context exceeding the review bound is refused instead of silently truncated. Source discovery returns the latest 30 entries, not a claim to have reviewed the entire conversation. Human interpretation remains the owning bot's responsibility, as in the existing discussion recorder.

The supported endpoints are owner-authenticated `GET /api/bots/decisions/:id/conversational-source` and `POST /api/bots/decisions/:id/conversational-decision`, exposed through native MCP tools. No manual business rows or legacy grant retrofit are used. Existing `answer_bridge` remains raw native answer/current/delivered-version readback; this release does **not** turn it into a dedicated external-service verifier or signed OrderOps proof.

## Case acceptance and remaining external blocker

Sage's owner-scoped readback confirmed native decision `353b6bff-eb83-48fc-b3c8-93907e9b8ba6` v1 and human result reply `4668f869-e306-414a-b3e1-ab85c6889440`. The full result includes both unplaced order #100121932 ($30.90, October 5) and an unrelated Piper price item. Platform Dev did not import, answer or execute that live case.

Sage alone must freshly inspect that exact source and current decision, read all subsequent human context, and determine whether the exact unchanged order/executor scope remains supported. A failed inspection is a concrete blocker; never manufacture a new binding to bypass it. No duplicate approval click is needed for eligible consent. This implementation commission is not purchasing authority.

Sage found no verified supported OrderOps timing-exception answer transport. Boris retains that separate incident with the existing OrderOps builder. This is a documented missing interface, not a proven API denial. Native deployment does not establish source-system acceptance or permit a purchase. No purchase, test order or customer effect occurred in validation.

## Verification

- Root typecheck passed.
- Scoped native consent, authenticated ingress, tools, native decisions, voice, guide and instruction context: 147 passed, including shared-queue reconciliation.
- Full root tests: 2,558 server passed (5 skipped), 907 web passed, 42 browser-manager passed, 29 installer passed.
- Additional guide/resumed instruction checks: 23 passed, including the new capability's employee and agent guidance.
- Isolated browser checks passed for full/restricted employees, desktop/mobile guide, new capability, search, navigation, refresh and failure recovery. All API data was mocked. Two test-selector errors were corrected before the passing run.
- Production build passed. Code commit `32aaa65` was pushed to `origin main`. All five services restarted on September 28, 09:28–09:29 Eastern; the runner restart interrupted the build turn after the other services reported healthy. Resumption verified the new runner process and a successful supported health check: local web/runner healthy, public front door HTTP 302, four tunnel edge connections. Authenticated public end-to-end chat and live case acceptance remain unverified. No second restart was needed.

## Changed files

- [Native recorder](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [Authenticated human source capture](/Users/archerclawdington/veneer-os/server/src/bots/humanMessages.ts)
- [Ingress](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [Native routes](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [MCP tools](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [Result-reply instructions](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [Immutable provenance migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0126_conversational_consent.sql)
- [Employee and agent catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Consent tests](/Users/archerclawdington/veneer-os/server/test/conversationalConsent.test.ts)
- [Ingress and tool tests](/Users/archerclawdington/veneer-os/server/test/conversationalConsentRoutes.test.ts)
- [Guide contract tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Guide browser checks](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
