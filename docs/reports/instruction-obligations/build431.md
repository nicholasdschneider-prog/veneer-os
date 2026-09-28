# BUILD431 — separate SMS obligations

## Implemented boundary

The original instruction-owning bot can inspect an authenticated direct human source already consumed for an email decision and an exact existing SMS draft, then preserve a separately reviewed outstanding intent. The source consumption remains single-use and unchanged. The new append-only ledger records actual observation time, original source/answer/proposal hashes, the later draft's exact payload/version/executor, context hash, and the bot's review attribution.

This is **intent tracking, not SMS authorization**. Every result is `ready:false`, `execute:false`. There is no new send/claim/delegation or customer effect. Exact authority for the later SMS draft and authenticated canonical-email/phone-case linkage remain missing. A draft context assertion does not prove either. No second customer approval is introduced as a technical workaround.

The read-only production refresh confirmed the supplied human source and unchanged ordinary SMS draft. No production obligation, draft, decision, approval, claim, lease, source/case/provider action or credential access was performed. Existing email resolver registration and approvals remain untouched. No alias was inferred.

## Original-owner next step

Grant, in his original authenticated conversation `cb4ade24-c960-4235-956a-220260e5adac`, can call:

```json
{
  "source_id": "9563bad3-6a4a-450d-952d-575082d8921d",
  "draft_id": "15da6c4b-6b12-4f19-9296-f923aa8431b2",
  "expected_draft_version": 1,
  "executor_conversation_id": "1e96b7bb-1071-4f1d-b710-310f9fbbc9e1"
}
```

Tool: `inspect_instruction_obligation`. If the draft has changed, inspect the actual current version; never reconstruct or overwrite the old payload. Read the entire returned source/context and current conversation. `record_instruction_obligation` is a separate owner-reviewed intent operation, not consent import; its exact input and limits are in the [contract](./contract.md). Platform does not impersonate Grant. Tess retains any eventual separately authorized customer execution, outside this build.

## Validation

Root Node24 typecheck passed. The focused suite passed 114 tests, including 20 new obligation tests, existing conversational consent and message-delegation tests, employee guide delivery and fresh/resumed agent instructions. Fixtures cover exact consumed-email/later-SMS provenance, read-only API behavior, original-owner/executor boundaries, private identity denial, context limits, stale payload/version/context, unchanged immutable email/draft, conflicting and identical replay, competing service instances, revocation and UNKNOWN/possible effects. No live customer acceptance test was run.

Full root `npm test` passed: 2,707 server tests (5 skipped), 909 web tests, 54 browser-manager tests and 29 installer tests. Root production build and `git diff --check` passed. The build emitted its existing chunk-size advisory, not a failure. Deployment verification follows below.

## Changed files

- [instructionObligations.ts](/Users/archerclawdington/veneer-os/server/src/bots/instructionObligations.ts)
- [0129_instruction_obligations.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0129_instruction_obligations.sql)
- [routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [instructionObligations.test.ts](/Users/archerclawdington/veneer-os/server/test/instructionObligations.test.ts)
- [botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [contract.md](/Users/archerclawdington/veneer-os/docs/reports/instruction-obligations/contract.md)
- [build431.md](/Users/archerclawdington/veneer-os/docs/reports/instruction-obligations/build431.md)
