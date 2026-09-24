# Deferred decision follow-up — BUILD290

## Implemented

New authenticated, version-bound human discussion messages posted while an exact proposal is **decided/deferred** now receive an immutable follow-up record. It binds the message to the original deferred answer event and canonical proposal hash. Merely posting does not change the defer or authorize execution.

The permanent owning bot may use existing `record_discussion_decision` for clear unconditional consent to that **unchanged exact proposal**. The service checks the author’s current eligibility, source message/version, latest human message, handler revision, original deferred answer and exact proposal hash. In one immediate transaction it copies the unchanged proposal to a successor version, retains the old defer in history, records the new actual human answer and creates the normal wake. Identical retries return current state without duplicate answers or wakes; conflicting retries fail. Use the returned version for all subsequent work.

Questions, conditions and investigation results remain discussion. Semantic interpretation remains the existing owning-bot contract; the server does not keyword-approve prose. Changed quantities, actions, material evidence, conditions or message text require a revised proposal and review, not this identical-scope continuation. Reject/withdraw, running and uncertain-effect work are not reopened by this path.

## Access reproduction and repair

Synthetic fixtures reproduced the access mismatch: an assignee can read an opted-in CS decision’s scoped same-business context while lacking whole-source-chat access, but `validateProposal` formerly required whole-source access again during revision. Existing-proposal validation now uses the same bounded decision-context rule for the assignee. The bot and permanent owner still require their original source access; private/foreign evidence remains denied and the assignee gains no source-chat grant. Bot ownership and human handler rules were not relaxed.

This reproduces the reported 404 mechanism from code and fixtures, not a fresh probe of Avery’s live record. No customer decision was read or mutated for diagnosis or testing.

## Original-record and message boundaries

The retained Nick message `40627c15-2551-4f84-a646-56bd6ea24e00` was reported with `instruction_version=null`. Migration0120 performs **no backfill**. That message cannot be retroactively turned into authorization. The live rails/order/notification/Auto-Ship work was not executed, resumed, rewritten or approved by this build.

The exact-message transport still hashes the complete structured payload, including body, and checks equality through delegation, acceptance and claim. It has no typed generated-order-number resolver or authenticated result-substitution contract. An unknown future order number therefore cannot be inserted into an old approved body. A supported final-message path requires a verified order-creation receipt and exact final structured message scope, or a separately implemented bounded typed result-binding contract linking the approved template, verified source receipt, named executor, immutable result value and final payload hash through every transport stage. Arbitrary placeholder replacement or generic business approval is not that contract. This release does not provide result binding or customer-send authority.

## Executable workflow

1. Owning bot reads current decision/version and investigates within existing authority. Revise materially changed recommendations through `update_decision`; do not import old null messages.
2. A genuine authorized human posts a fresh version-bound instruction for the displayed unchanged deferred proposal. The discussion API is the existing `POST /api/bots/decisions/:id/thread` with `expected_version`, stable `request_key`, `text`.
3. Owning bot calls `record_discussion_decision(decision_id,message_id,expected_version,action)` only for the whole message’s clear exact-scope instruction. Read the returned successor version. Existing material, delivery, financial and source gates still apply.
4. Different scope, missing provenance, revoked access, stale handling or ambiguous intent remains held with the precise conflict. No duplicate approval is needed for a successfully recorded exact instruction; no historical consent is synthesized.

## Validation and source

Synthetic fixtures cover defer → investigation → fresh exact instruction, unchanged old answer, legacy null untouched, idempotent retries, altered retry denial, superseding messages, changed proposal, revocation, no automatic approval of a conditional question, and scoped evidence revision without source-chat access. Existing suite checks shared handlers, competing answers, foreign actors, instruction attribution and delivery guards.

- [service.ts](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [0120_deferred_discussion_followups.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0120_deferred_discussion_followups.sql)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [bots.test.ts](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)

- [decision-discussion-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/decision-discussion-browser-check.mjs) accepts an isolated output directory for regression artifacts.

Root typecheck, full npm test and build passed. Test totals: server 2,427 passed / 5 existing skipped; web 880 passed; browser-manager 40 passed; installer 21 passed. Synthetic browser checks passed at five widths in both themes: collapsed details, keyboard/tap, discussion position, exact reply save, approval disabled during editing, stale polling protection and clean refresh. Guide checks passed for full/restricted routes, dated notices, navigation/search, mobile overflow and refresh; shared catalog tests verify resumed instruction delivery. No live business actions were used.

## Deployment receipt

Code commit `65abe49` pushed to `origin main`. Detached root restart completed; web, runner, app-runner, terminal and browser-manager all reported healthy. Read-only verification at 2026-09-24T14:44:31.661163+00:00: web `/healthz` HTTP200 (web/runner healthy), browser-manager `/health` HTTP200. Schema inspection confirms `bot_deferred_followups` and both immutable update/delete triggers. No live decision rows were read or changed for verification.

Historical null instructions remain untouched. This is a deployed fresh-follow-up/access repair, not a receipt for Avery’s customer remedy, order, notification or Auto-Ship execution. Generated-result message binding remains unsupported as described above.
